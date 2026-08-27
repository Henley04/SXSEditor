// sxs-ort-bridge -- NAPI addon exposing ONNX Runtime plugin execution-provider
// APIs (RegisterExecutionProviderLibrary / GetEpDevices /
// SessionOptionsAppendExecutionProvider_V2) to JavaScript.
//
// The addon dynamically resolves OrtGetApiBase() from the onnxruntime.dll that
// ships with the onnxruntime-node npm package, so it works without linking an
// ORT import library and stays ABI-compatible with whatever runtime the app
// already loads. Requires ORT >= 1.23 (plugin-EP ABI).
//
// Threading model: all exports are synchronous. Sessions are keyed by an
// opaque id; the registry is mutex-guarded so multiple worker_threads may hold
// sessions, but a single session must be used from one thread at a time
// (matches how the SVS pipeline uses its sessions).
#define NAPI_VERSION 8
#include <node_api.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <onnxruntime_c_api.h>
#include <map>
#include <mutex>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace {

const OrtApi* g_ort = nullptr;
OrtEnv* g_env = nullptr;
uint32_t g_apiVersion = 0;
bool g_initialized = false;

std::mutex g_sessionsMutex;
std::map<uint64_t, OrtSession*> g_sessions;
uint64_t g_nextSessionId = 1;

std::mutex g_devicesMutex;
std::vector<const OrtEpDevice*> g_devices;

std::string OrtMsg(OrtStatus* st) {
    const char* m = g_ort->GetErrorMessage(st);
    return m ? m : "unknown ort error";
}

napi_value RejectStr(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

#define CHECK_NAPI(call) do { napi_status s_ = (call); if (s_ != napi_ok) { \
    char b_[128]; snprintf(b_, sizeof(b_), "napi error %d", (int)s_); \
    napi_throw_error(env, nullptr, b_); return nullptr; } } while (0)

#define CHECK_ORT(st) do { OrtStatus* st_ = (st); if (st_) { \
    std::string m_ = OrtMsg(st_); g_ort->ReleaseStatus(st_); \
    napi_throw_error(env, nullptr, m_.c_str()); return nullptr; } } while (0)

std::string ToUtf8(napi_env env, napi_value v) {
    size_t len = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &len);
    std::string s(len, '\0');
    if (len) napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
    return s;
}

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
}

napi_value StrVal(napi_env env, const char* s) {
    napi_value v;
    napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v);
    return v;
}

size_t ElemSize(ONNXTensorElementDataType t) {
    switch (t) {
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT32: return 4;
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_DOUBLE:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT64: return 8;
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16:
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT16: return 2;
        default: return 1;
    }
}

ONNXTensorElementDataType TypeFromName(const std::string& t) {
    if (t == "float32") return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
    if (t == "int64") return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64;
    if (t == "int32") return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32;
    if (t == "float16") return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16;
    if (t == "uint8") return ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8;
    if (t == "int8") return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8;
    if (t == "bool") return ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL;
    return ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
}

const char* NameFromType(ONNXTensorElementDataType t) {
    switch (t) {
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT: return "float32";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64: return "int64";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32: return "int32";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16: return "float16";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8: return "uint8";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8: return "int8";
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL: return "bool";
        default: return "unknown";
    }
}

// Pick the newest supported ORT API version quietly: parse the runtime
// version string ("1.27.0" -> api 27) instead of probing downwards, which
// would print native errors to stderr on every failed attempt.
uint32_t NegotiateApiVersion(const OrtApiBase* base) {
    const char* ver = (base && base->GetVersionString) ? base->GetVersionString() : nullptr;
    if (ver && ver[0] == '1' && ver[1] == '.') {
        long minor = strtol(ver + 2, nullptr, 10);
        if (minor >= 23 && minor <= (long)ORT_API_VERSION) {
            if (base->GetApi((uint32_t)minor)) return (uint32_t)minor;
        }
    }
    for (uint32_t v = ORT_API_VERSION; v >= 23; --v) {
        if (base->GetApi(v)) return v;
    }
    return 0;
}

// ---------------- init(dllPath) -> { apiVersion } ----------------
napi_value Init(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc < 1 || !argv[0]) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] init(dllPath) required"); return nullptr; }

    if (g_initialized) {
        // Idempotent re-init: same-process second require() or worker reuse.
        napi_value obj, ver;
        CHECK_NAPI(napi_create_object(env, &obj));
        CHECK_NAPI(napi_create_uint32(env, g_apiVersion, &ver));
        CHECK_NAPI(napi_set_named_property(env, obj, "apiVersion", ver));
        return obj;
    }

    std::wstring dll = Utf8ToWide(ToUtf8(env, argv[0]));
    HMODULE h = LoadLibraryExW(dll.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!h) {
        char b[260];
        snprintf(b, sizeof(b), "[sxs-ort-bridge] LoadLibraryExW failed gle=%lu for '%s'",
                 GetLastError(), ToUtf8(env, argv[0]).c_str());
        napi_throw_error(env, nullptr, b);
        return nullptr;
    }
    auto getBase = reinterpret_cast<const OrtApiBase* (*)(void)>(
        reinterpret_cast<void*>(GetProcAddress(h, "OrtGetApiBase")));
    if (!getBase) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] OrtGetApiBase export not found"); return nullptr; }
    const OrtApiBase* base = getBase();
    if (!base) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] OrtGetApiBase() returned null"); return nullptr; }

    uint32_t v = NegotiateApiVersion(base);
    g_ort = v ? base->GetApi(v) : nullptr;
    if (!g_ort || !g_ort->RegisterExecutionProviderLibrary || !g_ort->GetEpDevices ||
        !g_ort->SessionOptionsAppendExecutionProvider_V2 || !g_ort->HardwareDevice_Type ||
        !g_ort->EpDevice_EpName || !g_ort->EpDevice_EpVendor || !g_ort->EpDevice_Device ||
        !g_ort->CreateEnv || !g_ort->CreateSession || !g_ort->Run) {
        napi_throw_error(env, nullptr, "[sxs-ort-bridge] ONNX Runtime lacks plugin-EP APIs (need >= 1.23)");
        return nullptr;
    }
    g_apiVersion = v;
    CHECK_ORT(g_ort->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "sxs-ort-bridge", &g_env));
    g_initialized = true;

    napi_value obj, ver;
    CHECK_NAPI(napi_create_object(env, &obj));
    CHECK_NAPI(napi_create_uint32(env, g_apiVersion, &ver));
    CHECK_NAPI(napi_set_named_property(env, obj, "apiVersion", ver));
    return obj;
}

// ---------------- registerEp(name, libPath) ----------------
napi_value RegisterEp(napi_env env, napi_callback_info info) {
    if (!g_initialized) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] not initialized"); return nullptr; }
    size_t argc = 2; napi_value argv[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    std::string name = ToUtf8(env, argv[0]);
    std::wstring lib = Utf8ToWide(ToUtf8(env, argv[1]));
    // Ensure the provider's directory is in DLL search path for its
    // dependencies (tensorrt_rtx_1_3.dll etc. in same folder). This is
    // required in Electron where the default search path doesn't include
    // WindowsApps ExecutionProvider folders.
    {
        size_t pos = lib.find_last_of(L"\\/");
        if (pos != std::wstring::npos) {
            std::wstring dir = lib.substr(0, pos);
            SetDllDirectoryW(dir.c_str());
            // AddDllDirectory requires LOAD_LIBRARY_SEARCH_USER_DIRS aware loads;
            // ORT uses LoadLibraryExW without that flag, so SetDllDirectory is primary.
            // Also try AddDllDirectory for completeness (KB2533623+).
            HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
            auto pAddDllDir = (decltype(&AddDllDirectory))GetProcAddress(k32, "AddDllDirectory");
            if (pAddDllDir) pAddDllDir(dir.c_str());
        }
    }
    OrtStatus* regSt = g_ort->RegisterExecutionProviderLibrary(g_env, name.c_str(), lib.c_str());
    DWORD gle = regSt ? GetLastError() : 0;
    if (regSt) {
        std::string m = OrtMsg(regSt); g_ort->ReleaseStatus(regSt);
        if (gle) { char g[64]; snprintf(g, sizeof(g), " [gle=%lu]", gle); m += g; }
        napi_throw_error(env, nullptr, m.c_str()); return nullptr;
    }

    std::lock_guard<std::mutex> lk(g_devicesMutex);
    g_devices.clear();
    const OrtEpDevice* const* devs = nullptr;
    size_t count = 0;
    CHECK_ORT(g_ort->GetEpDevices(g_env, &devs, &count));
    for (size_t i = 0; i < count; i++) g_devices.push_back(devs[i]);

    napi_value res;
    CHECK_NAPI(napi_get_boolean(env, true, &res));
    return res;
}

// ---------------- listDevices() -> [{index,epName,vendor,deviceType}] ----------------
napi_value ListDevices(napi_env env, napi_callback_info info) {
    if (!g_initialized) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] not initialized"); return nullptr; }
    std::lock_guard<std::mutex> lk(g_devicesMutex);
    napi_value arr;
    CHECK_NAPI(napi_create_array(env, &arr));
    for (size_t i = 0; i < g_devices.size(); i++) {
        const OrtEpDevice* d = g_devices[i];
        const OrtHardwareDevice* hw = g_ort->EpDevice_Device(d);
        const char* dt = "cpu";
        if (hw) {
            OrtHardwareDeviceType t = g_ort->HardwareDevice_Type(hw);
            if (t == OrtHardwareDeviceType_GPU) dt = "gpu";
            else if (t == OrtHardwareDeviceType_NPU) dt = "npu";
        }
        napi_value o, iv;
        CHECK_NAPI(napi_create_object(env, &o));
        CHECK_NAPI(napi_create_uint32(env, (uint32_t)i, &iv));
        CHECK_NAPI(napi_set_named_property(env, o, "index", iv));
        CHECK_NAPI(napi_set_named_property(env, o, "epName", StrVal(env, g_ort->EpDevice_EpName(d))));
        CHECK_NAPI(napi_set_named_property(env, o, "vendor", StrVal(env, g_ort->EpDevice_EpVendor(d))));
        CHECK_NAPI(napi_set_named_property(env, o, "deviceType", StrVal(env, dt)));
        CHECK_NAPI(napi_set_element(env, arr, (uint32_t)i, o));
    }
    return arr;
}

// ---------------- createSession(modelPath, deviceIndices[]) -> bigint id ----------------
napi_value CreateSession(napi_env env, napi_callback_info info) {
    if (!g_initialized) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] not initialized"); return nullptr; }
    size_t argc = 2; napi_value argv[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

    std::wstring model = Utf8ToWide(ToUtf8(env, argv[0]));
    uint32_t nIdx = 0;
    CHECK_NAPI(napi_get_array_length(env, argv[1], &nIdx));

    std::lock_guard<std::mutex> lk(g_devicesMutex);
    std::vector<const OrtEpDevice*> sel;
    sel.reserve(nIdx);
    for (uint32_t i = 0; i < nIdx; i++) {
        napi_value iv; uint32_t idx;
        CHECK_NAPI(napi_get_element(env, argv[1], i, &iv));
        CHECK_NAPI(napi_get_value_uint32(env, iv, &idx));
        if (idx < g_devices.size()) sel.push_back(g_devices[idx]);
    }

    OrtSessionOptions* so = nullptr;
    CHECK_ORT(g_ort->CreateSessionOptions(&so));
    g_ort->SetSessionGraphOptimizationLevel(so, ORT_ENABLE_ALL);
    if (!sel.empty()) {
        OrtStatus* st = g_ort->SessionOptionsAppendExecutionProvider_V2(
            so, g_env, sel.data(), sel.size(), nullptr, nullptr, 0);
        if (st) {
            g_ort->ReleaseSessionOptions(so);
            std::string m = OrtMsg(st); g_ort->ReleaseStatus(st);
            napi_throw_error(env, nullptr, m.c_str());
            return nullptr;
        }
    }
    OrtSession* s = nullptr;
    OrtStatus* st2 = g_ort->CreateSession(g_env, model.c_str(), so, &s);
    g_ort->ReleaseSessionOptions(so);
    if (st2) {
        std::string m = OrtMsg(st2); g_ort->ReleaseStatus(st2);
        napi_throw_error(env, nullptr, m.c_str());
        return nullptr;
    }
    uint64_t id;
    {
        std::lock_guard<std::mutex> slk(g_sessionsMutex);
        id = g_nextSessionId++;
        g_sessions[id] = s;
    }
    napi_value big;
    CHECK_NAPI(napi_create_bigint_uint64(env, id, &big));
    return big;
}

// ---- shared helper: fetch tensor name+type+shape into a JS object ----
bool AppendTensorInfo(napi_env env, napi_value arr, char* name, OrtAllocator* alloc,
                      const OrtTensorTypeAndShapeInfo* tsi) {
    ONNXTensorElementDataType et = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    if (g_ort->GetTensorElementType(tsi, &et) != nullptr) return false;
    size_t rank = 0;
    if (g_ort->GetDimensionsCount(tsi, &rank) != nullptr) return false;
    std::vector<int64_t> dims(rank ? rank : 0);
    if (rank && g_ort->GetDimensions(tsi, dims.data(), rank) != nullptr) return false;

    napi_value o, nv, tv, da;
    if (napi_create_object(env, &o) != napi_ok) return false;
    napi_create_string_utf8(env, name ? name : "", NAPI_AUTO_LENGTH, &nv);
    napi_set_named_property(env, o, "name", nv);
    napi_create_string_utf8(env, NameFromType(et), NAPI_AUTO_LENGTH, &tv);
    napi_set_named_property(env, o, "type", tv);
    napi_create_array(env, &da);
    for (size_t r = 0; r < rank; r++) {
        napi_value dv;
        napi_create_int64(env, dims[r], &dv);
        napi_set_element(env, da, (uint32_t)r, dv);
    }
    napi_set_named_property(env, o, "dims", da);
    uint32_t len = 0;
    napi_get_array_length(env, arr, &len);
    napi_set_element(env, arr, len, o);
    return true;
}

// ---------------- sessionInfo(id) -> {inputs:[{name,type,dims}],outputs:[...]} ----------------
napi_value SessionInfo(napi_env env, napi_callback_info info) {
    if (!g_initialized) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] not initialized"); return nullptr; }
    size_t argc = 1; napi_value argv[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    uint64_t id = 0; bool lossless = false;
    CHECK_NAPI(napi_get_value_bigint_uint64(env, argv[0], &id, &lossless));
    OrtSession* sess = nullptr;
    {
        std::lock_guard<std::mutex> slk(g_sessionsMutex);
        auto it = g_sessions.find(id);
        if (it == g_sessions.end()) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] bad session id"); return nullptr; }
        sess = it->second;
    }

    OrtAllocator* alloc = nullptr;
    CHECK_ORT(g_ort->GetAllocatorWithDefaultOptions(&alloc));

    napi_value resObj, inArr, outArr;
    CHECK_NAPI(napi_create_object(env, &resObj));
    CHECK_NAPI(napi_create_array(env, &inArr));
    CHECK_NAPI(napi_create_array(env, &outArr));

    size_t inCount = 0;
    CHECK_ORT(g_ort->SessionGetInputCount(sess, &inCount));
    for (size_t i = 0; i < inCount; i++) {
        char* nm = nullptr;
        CHECK_ORT(g_ort->SessionGetInputName(sess, i, alloc, &nm));
        OrtTypeInfo* ti = nullptr;
        OrtStatus* st = g_ort->SessionGetInputTypeInfo(sess, i, &ti);
        if (!st && ti) {
            const OrtTensorTypeAndShapeInfo* tsi = nullptr;
            OrtStatus* stCast = g_ort->CastTypeInfoToTensorInfo(ti, &tsi);
            if (!stCast && tsi) AppendTensorInfo(env, inArr, nm, alloc, tsi);
            else if (stCast) g_ort->ReleaseStatus(stCast);
            g_ort->ReleaseTypeInfo(ti);
        } else if (st) {
            g_ort->ReleaseStatus(st);
        }
        g_ort->AllocatorFree(alloc, nm);
    }
    size_t outCount = 0;
    CHECK_ORT(g_ort->SessionGetOutputCount(sess, &outCount));
    for (size_t i = 0; i < outCount; i++) {
        char* nm = nullptr;
        OrtStatus* stName = g_ort->SessionGetOutputName(sess, i, alloc, &nm);
        if (stName) { g_ort->ReleaseStatus(stName); continue; }
        OrtTypeInfo* ti = nullptr;
        OrtStatus* st = g_ort->SessionGetOutputTypeInfo(sess, i, &ti);
        if (!st && ti) {
            const OrtTensorTypeAndShapeInfo* tsi = nullptr;
            OrtStatus* stCast = g_ort->CastTypeInfoToTensorInfo(ti, &tsi);
            if (!stCast && tsi) AppendTensorInfo(env, outArr, nm, alloc, tsi);
            else if (stCast) g_ort->ReleaseStatus(stCast);
            g_ort->ReleaseTypeInfo(ti);
        } else if (st) {
            g_ort->ReleaseStatus(st);
        }
        g_ort->AllocatorFree(alloc, nm);
    }
    CHECK_NAPI(napi_set_named_property(env, resObj, "inputs", inArr));
    CHECK_NAPI(napi_set_named_property(env, resObj, "outputs", outArr));
    return resObj;
}

// ---------------- run(id, feeds{ name:{type,data:ArrayBuffer,dims} }) -> outputs ----------------
napi_value Run(napi_env env, napi_callback_info info) {
    if (!g_initialized) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] not initialized"); return nullptr; }
    size_t argc = 2; napi_value argv[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    uint64_t id = 0; bool lossless = false;
    CHECK_NAPI(napi_get_value_bigint_uint64(env, argv[0], &id, &lossless));
    OrtSession* sess = nullptr;
    {
        std::lock_guard<std::mutex> slk(g_sessionsMutex);
        auto it = g_sessions.find(id);
        if (it == g_sessions.end()) { napi_throw_error(env, nullptr, "[sxs-ort-bridge] bad session id"); return nullptr; }
        sess = it->second;
    }

    napi_value keys;
    CHECK_NAPI(napi_get_property_names(env, argv[1], &keys));
    uint32_t nKeys = 0;
    CHECK_NAPI(napi_get_array_length(env, keys, &nKeys));

    std::vector<std::string> inNames;
    inNames.reserve(nKeys);
    for (uint32_t k = 0; k < nKeys; k++) {
        napi_value keyV;
        CHECK_NAPI(napi_get_element(env, keys, k, &keyV));
        inNames.push_back(ToUtf8(env, keyV));
    }
    std::vector<const char*> inNamePtrs;
    inNamePtrs.reserve(nKeys);
    for (uint32_t k = 0; k < nKeys; k++) inNamePtrs.push_back(inNames[k].c_str());

    std::vector<OrtValue*> inputs(nKeys, nullptr);
    OrtMemoryInfo* mi = nullptr;
    CHECK_ORT(g_ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mi));

    for (uint32_t k = 0; k < nKeys; k++) {
        napi_value keyV, desc;
        CHECK_NAPI(napi_get_element(env, keys, k, &keyV));
        CHECK_NAPI(napi_get_property(env, argv[1], keyV, &desc));
        napi_value typeV, dataV, dimsV;
        CHECK_NAPI(napi_get_named_property(env, desc, "type", &typeV));
        CHECK_NAPI(napi_get_named_property(env, desc, "data", &dataV));
        CHECK_NAPI(napi_get_named_property(env, desc, "dims", &dimsV));

        std::string type = ToUtf8(env, typeV);
        void* data = nullptr;
        size_t len = 0;
        CHECK_NAPI(napi_get_arraybuffer_info(env, dataV, &data, &len));
        uint32_t rank = 0;
        CHECK_NAPI(napi_get_array_length(env, dimsV, &rank));
        std::vector<int64_t> dims(rank);
        size_t total = 1;
        for (uint32_t i = 0; i < rank; i++) {
            napi_value dv; uint32_t d;
            CHECK_NAPI(napi_get_element(env, dimsV, i, &dv));
            CHECK_NAPI(napi_get_value_uint32(env, dv, &d));
            dims[i] = d;
            total *= d;
        }
        ONNXTensorElementDataType et = TypeFromName(type);
        if (et == ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED || total * ElemSize(et) > len) {
            g_ort->ReleaseMemoryInfo(mi);
            std::string msg = "[sxs-ort-bridge] bad feed descriptor for '" + inNames[k] + "'";
            napi_throw_error(env, nullptr, msg.c_str());
            return nullptr;
        }
        OrtStatus* st = g_ort->CreateTensorWithDataAsOrtValue(mi, data, len, dims.data(), rank, et, &inputs[k]);
        if (st) {
            g_ort->ReleaseMemoryInfo(mi);
            std::string m = OrtMsg(st); g_ort->ReleaseStatus(st);
            napi_throw_error(env, nullptr, m.c_str());
            return nullptr;
        }
    }

    OrtAllocator* alloc = nullptr;
    CHECK_ORT(g_ort->GetAllocatorWithDefaultOptions(&alloc));

    size_t outCount = 0;
    CHECK_ORT(g_ort->SessionGetOutputCount(sess, &outCount));
    std::vector<std::string> outNames;
    outNames.reserve(outCount);
    for (size_t i = 0; i < outCount; i++) {
        char* nm = nullptr;
        OrtStatus* stN = g_ort->SessionGetOutputName(sess, i, alloc, &nm);
        if (stN) { g_ort->ReleaseStatus(stN); outNames.push_back(""); continue; }
        outNames.push_back(nm ? nm : "");
        g_ort->AllocatorFree(alloc, nm);
    }
    std::vector<const char*> outNamePtrs;
    outNamePtrs.reserve(outCount);
    for (size_t i = 0; i < outCount; i++) outNamePtrs.push_back(outNames[i].c_str());
    std::vector<OrtValue*> outputs(outCount, nullptr);

    OrtStatus* stRun = g_ort->Run(sess, nullptr, inNamePtrs.data(), inputs.data(), inputs.size(),
                                  outNamePtrs.data(), outCount, outputs.data());
    g_ort->ReleaseMemoryInfo(mi);
    for (auto v : inputs) if (v) g_ort->ReleaseValue(v);
    if (stRun) {
        std::string m = OrtMsg(stRun); g_ort->ReleaseStatus(stRun);
        for (auto v : outputs) if (v) g_ort->ReleaseValue(v);
        napi_throw_error(env, nullptr, m.c_str());
        return nullptr;
    }

    napi_value resObj;
    CHECK_NAPI(napi_create_object(env, &resObj));
    for (size_t i = 0; i < outCount; i++) {
        if (!outputs[i]) continue;
        OrtTensorTypeAndShapeInfo* tsi = nullptr;
        if (g_ort->GetTensorTypeAndShape(outputs[i], &tsi) != nullptr || !tsi) {
            if (tsi) g_ort->ReleaseTensorTypeAndShapeInfo(tsi);
            g_ort->ReleaseValue(outputs[i]);
            continue;
        }
        ONNXTensorElementDataType et = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
        if (g_ort->GetTensorElementType(tsi, &et) != nullptr) {
            g_ort->ReleaseTensorTypeAndShapeInfo(tsi);
            g_ort->ReleaseValue(outputs[i]);
            continue;
        }
        size_t rank = 0;
        g_ort->GetDimensionsCount(tsi, &rank);
        std::vector<int64_t> dims(rank);
        if (rank) g_ort->GetDimensions(tsi, dims.data(), rank);
        size_t total = 1;
        for (auto d : dims) total *= (size_t)(d > 0 ? d : 1);
        g_ort->ReleaseTensorTypeAndShapeInfo(tsi);

        size_t bytes = total * ElemSize(et);
        void* src = nullptr;
        if (g_ort->GetTensorMutableData(outputs[i], &src) != nullptr || !src) src = nullptr;
        void* copy = malloc(bytes ? bytes : 1);
        if (src) memcpy(copy, src, bytes);
        else memset(copy, 0, bytes);

        napi_value ab, oo, tv, da;
        if (napi_create_external_arraybuffer(env, copy, bytes,
                [](napi_env, void* p, void*) { free(p); }, nullptr, &ab) != napi_ok) {
            free(copy);
            ab = nullptr;
            napi_create_arraybuffer(env, bytes, &copy, &ab);
            // extremely unlikely; skip content on failure
        }
        CHECK_NAPI(napi_create_object(env, &oo));
        CHECK_NAPI(napi_create_string_utf8(env, NameFromType(et), NAPI_AUTO_LENGTH, &tv));
        CHECK_NAPI(napi_set_named_property(env, oo, "type", tv));
        if (ab) CHECK_NAPI(napi_set_named_property(env, oo, "data", ab));
        CHECK_NAPI(napi_create_array(env, &da));
        for (size_t r = 0; r < rank; r++) {
            napi_value dv;
            CHECK_NAPI(napi_create_int64(env, dims[r], &dv));
            CHECK_NAPI(napi_set_element(env, da, (uint32_t)r, dv));
        }
        CHECK_NAPI(napi_set_named_property(env, oo, "dims", da));
        CHECK_NAPI(napi_set_named_property(env, resObj, outNames[i].c_str(), oo));
        g_ort->ReleaseValue(outputs[i]);
    }
    return resObj;
}

// ---------------- releaseSession(id) ----------------
napi_value ReleaseSession(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    uint64_t id = 0; bool lossless = false;
    CHECK_NAPI(napi_get_value_bigint_uint64(env, argv[0], &id, &lossless));
    {
        std::lock_guard<std::mutex> slk(g_sessionsMutex);
        auto it = g_sessions.find(id);
        if (it != g_sessions.end()) {
            g_ort->ReleaseSession(it->second);
            g_sessions.erase(it);
        }
    }
    napi_value undef;
    CHECK_NAPI(napi_get_undefined(env, &undef));
    return undef;
}

// ---------------- disposeAll() -- release every session (worker shutdown) ----------------
napi_value DisposeAll(napi_env env, napi_callback_info info) {
    {
        std::lock_guard<std::mutex> slk(g_sessionsMutex);
        for (auto& kv : g_sessions) g_ort->ReleaseSession(kv.second);
        g_sessions.clear();
    }
    napi_value undef;
    CHECK_NAPI(napi_get_undefined(env, &undef));
    return undef;
}

napi_value DefProp(napi_env env, const char* name, napi_callback cb) {
    napi_value fn;
    napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn);
    return fn;
}

napi_value CanLoadLibrary(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    std::wstring lib = Utf8ToWide(ToUtf8(env, argv[0]));
    // Try LoadLibraryEx with same flags as RegisterEp's dependency handling
    size_t pos = lib.find_last_of(L"\\/");
    if (pos != std::wstring::npos) {
        std::wstring dir = lib.substr(0, pos);
        SetDllDirectoryW(dir.c_str());
        HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
        auto pAddDllDir = (decltype(&AddDllDirectory))GetProcAddress(k32, "AddDllDirectory");
        if (pAddDllDir) pAddDllDir(dir.c_str());
    }
    HMODULE h = LoadLibraryExW(lib.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    napi_value res;
    if (h) {
        FreeLibrary(h);
        CHECK_NAPI(napi_get_boolean(env, true, &res));
    } else {
        CHECK_NAPI(napi_get_boolean(env, false, &res));
    }
    // Reset DLL directory
    SetDllDirectoryW(L"");
    return res;
}

napi_value ModuleInit(napi_env env, napi_value exports) {
    napi_set_named_property(env, exports, "init", DefProp(env, "init", Init));
    napi_set_named_property(env, exports, "registerEp", DefProp(env, "registerEp", RegisterEp));
    napi_set_named_property(env, exports, "canLoadLibrary", DefProp(env, "canLoadLibrary", CanLoadLibrary));
    napi_set_named_property(env, exports, "listDevices", DefProp(env, "listDevices", ListDevices));
    napi_set_named_property(env, exports, "createSession", DefProp(env, "createSession", CreateSession));
    napi_set_named_property(env, exports, "sessionInfo", DefProp(env, "sessionInfo", SessionInfo));
    napi_set_named_property(env, exports, "run", DefProp(env, "run", Run));
    napi_set_named_property(env, exports, "releaseSession", DefProp(env, "releaseSession", ReleaseSession));
    napi_set_named_property(env, exports, "disposeAll", DefProp(env, "disposeAll", DisposeAll));
    return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
