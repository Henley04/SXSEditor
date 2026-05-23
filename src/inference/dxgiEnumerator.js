/**
 * DXGI GPU 枚举模块 — 使用 koffi FFI 直接调用 dxgi.dll
 * 替代 C# + PowerShell 方案，无需 CSC 编译器
 */

const koffi = require('koffi');

// IID 常量
const IID_IDXGIFactory1 = '{770aae78-f26f-4dba-a829-253c83d1b387}';
const IID_IDXGIAdapter3 = '{645967A4-1392-4310-A798-8053CE3E93FD}';

// COM vtable 偏移
const VT_QUERY_INTERFACE = 0;
const VT_RELEASE = 2;
const VT_ENUM_ADAPTERS1 = 12;
const VT_GET_DESC1 = 10;
const VT_QUERY_VIDEO_MEMORY_INFO = 14;

// 预定义 COM 函数原型 (stdcall)，避免循环中重复定义
const IUnknownReleaseProto = koffi.proto('uint __stdcall IUnknownRelease(void *This)');
const IUnknownQueryInterfaceProto = koffi.proto('int32 __stdcall IUnknownQI(void *This, void *riid, _Out_ void **ppvObject)');
const EnumAdapters1Proto = koffi.proto('int32 __stdcall EnumAdapters1(void *This, uint Adapter, _Out_ void **ppAdapter)');
const GetDesc1Proto = koffi.proto('int32 __stdcall GetDesc1(void *This, _Out_ void *pDesc)');
const QueryVideoMemoryInfoProto = koffi.proto('int32 __stdcall QueryVideoMemoryInfo(void *This, uint NodeIndex, uint MemorySegmentGroup, _Out_ void *pVideoMemoryInfo)');

let dxgiLib = null;

function _loadLibs() {
  if (!dxgiLib) {
    dxgiLib = koffi.load('dxgi.dll');
  }
}

/**
 * 将 GUID 字符串转为 16 字节 Buffer
 */
function _guidToBuffer(guidStr) {
  const parts = guidStr.replace(/[{}]/g, '').split('-');
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(parseInt(parts[0], 16), 0);
  buf.writeUInt16LE(parseInt(parts[1], 16), 4);
  buf.writeUInt16LE(parseInt(parts[2], 16), 6);
  Buffer.from(parts[3] + parts[4], 'hex').copy(buf, 8);
  return buf;
}

/**
 * 从 COM 对象指针读取 vtable 中指定 slot 的函数指针
 * koffi 3.x: 指针是 BigInt，用 koffi.decode(ptr, 'void *') 解引用
 */
function _readVtableSlot(comPtr, slot) {
  const vtblPtr = koffi.decode(comPtr, 'void *');
  return koffi.decode(vtblPtr + BigInt(slot) * 8n, 'void *');
}

/**
 * 调用 IUnknown::Release
 */
function _release(comPtr) {
  try {
    const funcPtr = _readVtableSlot(comPtr, VT_RELEASE);
    const release = koffi.decode(funcPtr, IUnknownReleaseProto);
    release(comPtr);
  } catch (_) {}
}

/**
 * 枚举所有 GPU 适配器 (通过 koffi FFI 直接调用 dxgi.dll)
 */
function enumerateGPUs() {
  _loadLibs();

  const CreateDXGIFactory1 = dxgiLib.func('int32 __stdcall CreateDXGIFactory1(void *riid, _Out_ void **ppFactory)');

  const iidBuf = _guidToBuffer(IID_IDXGIFactory1);
  const factoryOut = [null];

  const hr = CreateDXGIFactory1(iidBuf, factoryOut);
  if (hr !== 0) {
    console.warn('[DXGIEnumerator] CreateDXGIFactory1 失败, hr=', hr);
    return [];
  }

  const factoryPtr = factoryOut[0];
  const devices = [];

  try {
    const enumAdapters1Ptr = _readVtableSlot(factoryPtr, VT_ENUM_ADAPTERS1);
    const EnumAdapters1 = koffi.decode(enumAdapters1Ptr, EnumAdapters1Proto);

    for (let i = 0; i < 16; i++) {
      const adapterOut = [null];
      const enumHr = EnumAdapters1(factoryPtr, i, adapterOut);
      if (enumHr !== 0) break;

      const adapterPtr = adapterOut[0];

      try {
        const getDesc1Ptr = _readVtableSlot(adapterPtr, VT_GET_DESC1);
        const GetDesc1 = koffi.decode(getDesc1Ptr, GetDesc1Proto);

        const descBuf = Buffer.alloc(320);
        const descHr = GetDesc1(adapterPtr, descBuf);
        if (descHr !== 0) continue;

        // 解析 DXGI_ADAPTER_DESC1
        let description = '';
        for (let j = 0; j < 128; j++) {
          const ch = descBuf.readUInt16LE(j * 2);
          if (ch === 0) break;
          description += String.fromCharCode(ch);
        }
        const vendorId = descBuf.readUInt32LE(256);
        const deviceId = descBuf.readUInt32LE(260);
        const dedicatedVideoMemory = descBuf.readBigUInt64LE(272);
        const flags = descBuf.readUInt32LE(304);

        // 跳过软件适配器 (flags & 2)
        if ((flags & 2) !== 0) {
          _release(adapterPtr);
          continue;
        }

        // 尝试 QueryInterface 获取 IDXGIAdapter3 以查询 VRAM 使用量
        let currentUsage = 0n;
        let budget = 0n;

        try {
          const qiPtr = _readVtableSlot(adapterPtr, VT_QUERY_INTERFACE);
          const QueryInterface = koffi.decode(qiPtr, IUnknownQueryInterfaceProto);

          const adapter3Iid = _guidToBuffer(IID_IDXGIAdapter3);
          const adapter3Out = [null];
          const qiHr = QueryInterface(adapterPtr, adapter3Iid, adapter3Out);

          if (qiHr === 0 && adapter3Out[0]) {
            const adapter3Ptr = adapter3Out[0];
            try {
              const qvmiPtr = _readVtableSlot(adapter3Ptr, VT_QUERY_VIDEO_MEMORY_INFO);
              const QueryVideoMemoryInfo = koffi.decode(qvmiPtr, QueryVideoMemoryInfoProto);

              const vramInfoBuf = Buffer.alloc(32);
              const qvmiHr = QueryVideoMemoryInfo(adapter3Ptr, 0, 0, vramInfoBuf);
              if (qvmiHr === 0) {
                budget = vramInfoBuf.readBigUInt64LE(0);
                currentUsage = vramInfoBuf.readBigUInt64LE(8);
              }
            } finally {
              _release(adapter3Ptr);
            }
          }
        } catch (_) {}

        devices.push({
          adapterIndex: i,
          name: description,
          totalBytes: Number(dedicatedVideoMemory),
          usageBytes: Number(currentUsage),
          budgetBytes: Number(budget),
          vendorId,
          deviceId,
        });
      } finally {
        _release(adapterPtr);
      }
    }
  } finally {
    _release(factoryPtr);
  }

  return devices;
}

/**
 * 枚举 GPU 适配器（设备枚举格式，供 nativeSvsPipeline 使用）
 */
function enumerateGPUAdapters() {
  const adapters = enumerateGPUs();
  return adapters.map(a => {
    const vramBytes = a.totalBytes;
    const gb = vramBytes / (1024 * 1024 * 1024);
    const vramStr = gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(vramBytes / (1024 * 1024))} MB`;

    const vendors = { 0x10DE: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x1414: 'Microsoft' };

    const n = a.name.toLowerCase();
    let isDiscrete = undefined;
    if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('gtx') || n.includes('quadro')) isDiscrete = true;
    else if (n.includes('radeon rx') || n.includes('radeon pro') || n.includes('radeon instinct')) isDiscrete = true;
    else if (n.includes('arc') && n.includes('intel')) isDiscrete = true;
    else if (n.includes('intel') && (n.includes('uhd') || n.includes('iris') || n.includes('xe') || n.includes('hd graphics'))) isDiscrete = false;
    else if (n.includes('radeon') && !n.includes('rx') && !n.includes('pro') && !n.includes('instinct')) isDiscrete = false;
    else if (n.includes('microsoft') && n.includes('basic')) isDiscrete = false;

    return {
      name: a.name,
      type: 1,
      isDiscrete: isDiscrete !== undefined ? isDiscrete : (vramBytes > 0 && vramBytes >= 512 * 1024 * 1024),
      dxgiAdapterNumber: a.adapterIndex,
      vram: vramStr,
      vramBytes: vramBytes,
      vendor: vendors[a.vendorId] || '',
      source: 'dxgi-ffi',
    };
  });
}

/**
 * 查询 GPU VRAM 使用量（供 main.js 使用）
 */
function queryVRAMUsage() {
  const adapters = enumerateGPUs();
  return adapters.map(a => ({
    adapterIndex: a.adapterIndex,
    name: a.name,
    totalBytes: a.totalBytes,
    usageBytes: a.usageBytes,
    budgetBytes: a.budgetBytes,
  }));
}

module.exports = { enumerateGPUAdapters, queryVRAMUsage };
