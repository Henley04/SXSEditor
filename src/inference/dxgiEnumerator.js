/**
 * DXGI GPU 枚举模块 — 使用 koffi FFI 直接调用 dxgi.dll
 * 替代 C# + PowerShell 方案，无需 CSC 编译器
 */

const koffi = require('koffi');

// DXGI_ADAPTER_DESC1 结构体布局 (共 320 字节)
// typedef struct DXGI_ADAPTER_DESC1 {
//   WCHAR Description[128];     // 0-255 (128 * 2 bytes)
//   UINT VendorId;              // 256
//   UINT DeviceId;              // 260
//   UINT SubSysId;              // 264
//   UINT Revision;              // 268
//   SIZE_T DedicatedVideoMemory;// 272
//   SIZE_T DedicatedSystemMemory;// 280
//   SIZE_T SharedSystemMemory;  // 288
//   LUID AdapterLuid;           // 296
//   UINT Flags;                 // 304
// }

// DXGI_QUERY_VIDEO_MEMORY_INFO 结构体 (32 字节)
// typedef struct DXGI_QUERY_VIDEO_MEMORY_INFO {
//   UINT64 Budget;              // 0
//   UINT64 CurrentUsage;        // 8
//   UINT64 AvailableForReservation; // 16
//   UINT64 CurrentReservation;  // 24
// }

const IID_IDXGIFactory1 = '{770aae78-f26f-4dba-a829-253c83d1b387}';
const IID_IDXGIAdapter3 = '{645967A4-1392-4310-A798-8053CE3E93FD}';

// COM vtable 偏移 (与原 C# 代码一致)
const VT_ENUM_ADAPTERS1 = 12; // IDXGIFactory1::EnumAdapters1
const VT_GET_DESC1 = 10;      // IDXGIAdapter1::GetDesc1
const VT_RELEASE = 2;         // IUnknown::Release
const VT_QUERY_VIDEO_MEMORY_INFO = 14; // IDXGIAdapter3::QueryVideoMemoryInfo

let dxgiLib = null;
let ole32Lib = null;

function _loadLibs() {
  if (!dxgiLib) {
    dxgiLib = koffi.load('dxgi.dll');
  }
  if (!ole32Lib) {
    ole32Lib = koffi.load('ole32.dll');
  }
}

/**
 * 从 COM 对象指针读取 vtable 中的函数指针并调用
 */
function _readVtableFunc(comPtr, slot) {
  const vtbl = comPtr.readPointer();
  return vtbl.readPointer(slot * process.arch === 'x64' ? 8 : 4);
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
  // parts[3] 和 parts[4] 是大端序
  Buffer.from(parts[3], 'hex').copy(buf, 8);
  Buffer.from(parts[4], 'hex').copy(buf, 12);
  return buf;
}

/**
 * 从 DXGI_ADAPTER_DESC1 内存中解析适配器信息
 */
function _parseAdapterDesc1(descBuf, adapterIndex) {
  // Description: 128 个 WCHAR (UTF-16LE)，偏移 0
  let description = '';
  for (let i = 0; i < 128; i++) {
    const ch = descBuf.readUInt16LE(i * 2);
    if (ch === 0) break;
    description += String.fromCharCode(ch);
  }

  const vendorId = descBuf.readUInt32LE(256);
  const deviceId = descBuf.readUInt32LE(260);
  const dedicatedVideoMemory = descBuf.readBigUInt64LE(272);
  const flags = descBuf.readUInt32LE(304);

  return { description, vendorId, deviceId, dedicatedVideoMemory, flags, adapterIndex };
}

/**
 * 枚举所有 GPU 适配器 (通过 koffi FFI 直接调用 dxgi.dll)
 * 返回格式与原 enumerateGPUsViaDXGI 一致
 */
function enumerateGPUs() {
  _loadLibs();

  const CreateDXGIFactory1 = dxgiLib.func('HRESULT __stdcall CreateDXGIFactory1(REFIID riid, void **ppFactory)');
  const CoTaskMemFree = ole32Lib.func('void __stdcall CoTaskMemFree(void *pv)');

  const iidBuf = _guidToBuffer(IID_IDXGIFactory1);
  const factoryPtrBuf = Buffer.alloc(process.arch === 'x64' ? 8 : 4);

  const hr = CreateDXGIFactory1(iidBuf, factoryPtrBuf);
  if (hr !== 0) {
    console.warn('[DXGIEnumerator] CreateDXGIFactory1 失败, hr=', hr);
    return [];
  }

  const factoryPtr = koffi.as(factoryPtrBuf.readPointer(), 'void *');
  const devices = [];

  try {
    // 读取 EnumAdapters1 函数指针
    const enumAdapters1FuncPtr = _readVtableFunc(factoryPtr, VT_ENUM_ADAPTERS1);
    const EnumAdapters1 = koffi.func('__stdcall', 'HRESULT', ['void *', 'uint', 'void **'], enumAdapters1FuncPtr);

    for (let i = 0; i < 16; i++) {
      const adapterPtrBuf = Buffer.alloc(process.arch === 'x64' ? 8 : 4);
      const enumHr = EnumAdapters1(factoryPtr, i, adapterPtrBuf);
      if (enumHr !== 0) break; // DXGI_ERROR_NOT_FOUND

      const adapterPtr = koffi.as(adapterPtrBuf.readPointer(), 'void *');

      try {
        // 读取 GetDesc1 函数指针
        const getDesc1FuncPtr = _readVtableFunc(adapterPtr, VT_GET_DESC1);
        const GetDesc1 = koffi.func('__stdcall', 'HRESULT', ['void *', 'void *'], getDesc1FuncPtr);

        // 分配 320 字节缓冲区存放 DXGI_ADAPTER_DESC1
        const descBuf = Buffer.alloc(320);
        const descHr = GetDesc1(adapterPtr, descBuf);
        if (descHr !== 0) continue;

        const info = _parseAdapterDesc1(descBuf, i);

        // 跳过软件适配器 (flags & 2)
        if ((info.flags & 2) !== 0) {
          _releaseComObject(adapterPtr);
          continue;
        }

        // 尝试 QueryInterface 获取 IDXGIAdapter3 以查询 VRAM 使用量
        let currentUsage = 0n;
        let budget = 0n;

        try {
          const adapter3Ptr = _queryInterface(adapterPtr, IID_IDXGIAdapter3);
          if (adapter3Ptr) {
            try {
              const qvmiFuncPtr = _readVtableFunc(adapter3Ptr, VT_QUERY_VIDEO_MEMORY_INFO);
              const QueryVideoMemoryInfo = koffi.func('__stdcall', 'HRESULT', ['void *', 'uint', 'uint', 'void *'], qvmiFuncPtr);

              const vramInfoBuf = Buffer.alloc(32);
              const qvmiHr = QueryVideoMemoryInfo(adapter3Ptr, 0, 0, vramInfoBuf);
              if (qvmiHr === 0) {
                budget = vramInfoBuf.readBigUInt64LE(0);
                currentUsage = vramInfoBuf.readBigUInt64LE(8);
              }
            } finally {
              _releaseComObject(adapter3Ptr);
            }
          }
        } catch (_) {}

        devices.push({
          adapterIndex: i,
          name: info.description,
          totalBytes: Number(info.dedicatedVideoMemory),
          usageBytes: Number(currentUsage),
          budgetBytes: Number(budget),
          vendorId: info.vendorId,
          deviceId: info.deviceId,
        });
      } finally {
        _releaseComObject(adapterPtr);
      }
    }
  } finally {
    _releaseComObject(factoryPtr);
  }

  return devices;
}

/**
 * 调用 IUnknown::Release
 */
function _releaseComObject(comPtr) {
  try {
    const releaseFuncPtr = _readVtableFunc(comPtr, VT_RELEASE);
    const Release = koffi.func('__stdcall', 'uint', ['void *'], releaseFuncPtr);
    Release(comPtr);
  } catch (_) {}
}

/**
 * 调用 IUnknown::QueryInterface
 */
function _queryInterface(comPtr, iidStr) {
  const qiFuncPtr = _readVtableFunc(comPtr, 0); // slot 0 = QueryInterface
  const QueryInterface = koffi.func('__stdcall', 'HRESULT', ['void *', 'void *', 'void **'], qiFuncPtr);

  const iidBuf = _guidToBuffer(iidStr);
  const outPtrBuf = Buffer.alloc(process.arch === 'x64' ? 8 : 4);

  const hr = QueryInterface(comPtr, iidBuf, outPtrBuf);
  if (hr !== 0) return null;

  return koffi.as(outPtrBuf.readPointer(), 'void *');
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

    // 判断是否独显
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
