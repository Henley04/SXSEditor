/**
 * DXGI GPU 枚举模块
 * 优先使用 koffi FFI 直接调用 dxgi.dll（无需 CSC 编译器）
 * koffi 不可用时返回空数组，由调用方回退到 CIM/ONNX Runtime 方案
 */

// IID 常量
const IID_IDXGIFactory1 = '{770aae78-f26f-4dba-a829-253c83d1b387}';
const IID_IDXGIAdapter3 = '{645967A4-1392-4310-A798-8053CE3E93FD}';

// COM vtable 偏移
const VT_QUERY_INTERFACE = 0;
const VT_RELEASE = 2;
const VT_ENUM_ADAPTERS1 = 12;
const VT_GET_DESC1 = 10;
const VT_QUERY_VIDEO_MEMORY_INFO = 14;

// 延迟初始化
let koffiAvailable = null; // null=未检测, true=可用, false=不可用
let koffi = null;
let dxgiLib = null;
let IUnknownReleaseProto = null;
let IUnknownQueryInterfaceProto = null;
let EnumAdapters1Proto = null;
let GetDesc1Proto = null;
let QueryVideoMemoryInfoProto = null;

function _initKoffi() {
  if (koffiAvailable !== null) return koffiAvailable;

  try {
    koffi = require('koffi');
    dxgiLib = koffi.load('dxgi.dll');

    IUnknownReleaseProto = koffi.proto('uint __stdcall IUnknownRelease(void *This)');
    IUnknownQueryInterfaceProto = koffi.proto('int32 __stdcall IUnknownQI(void *This, void *riid, _Out_ void **ppvObject)');
    EnumAdapters1Proto = koffi.proto('int32 __stdcall EnumAdapters1(void *This, uint Adapter, _Out_ void **ppAdapter)');
    GetDesc1Proto = koffi.proto('int32 __stdcall GetDesc1(void *This, _Out_ void *pDesc)');
    QueryVideoMemoryInfoProto = koffi.proto('int32 __stdcall QueryVideoMemoryInfo(void *This, uint NodeIndex, uint MemorySegmentGroup, _Out_ void *pVideoMemoryInfo)');

    koffiAvailable = true;
  } catch (e) {
    console.warn('[DXGIEnumerator] koffi 不可用:', e.message);
    koffiAvailable = false;
  }

  return koffiAvailable;
}

function _guidToBuffer(guidStr) {
  const parts = guidStr.replace(/[{}]/g, '').split('-');
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(parseInt(parts[0], 16), 0);
  buf.writeUInt16LE(parseInt(parts[1], 16), 4);
  buf.writeUInt16LE(parseInt(parts[2], 16), 6);
  Buffer.from(parts[3] + parts[4], 'hex').copy(buf, 8);
  return buf;
}

function _readVtableSlot(comPtr, slot) {
  const vtblPtr = koffi.decode(comPtr, 'void *');
  return koffi.decode(vtblPtr + BigInt(slot) * 8n, 'void *');
}

function _release(comPtr) {
  try {
    const funcPtr = _readVtableSlot(comPtr, VT_RELEASE);
    const release = koffi.decode(funcPtr, IUnknownReleaseProto);
    release(comPtr);
  } catch (_) {}
}

function enumerateGPUs() {
  if (!_initKoffi()) return [];

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

        if ((flags & 2) !== 0) {
          _release(adapterPtr);
          continue;
        }

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
