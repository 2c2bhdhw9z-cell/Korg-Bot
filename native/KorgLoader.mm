// Original Korg loader implementation. See ABI.md for the versioned contract.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace korg {
// Stand-ins for facebook::jsi types, with the Itanium-ABI shapes React Native 0.86 / Hermes 1.0 use. No React Native
// header is included. The host's virtual-table layout is verified at run time by checkLayout() before any call.
struct Runtime;  // facebook::jsi::Runtime, only ever used through a pointer

// facebook::jsi::Buffer: a virtual destructor (two slots), then size() and data().
class Input {
 public:
  virtual ~Input() = default;
  virtual size_t length() const = 0;
  virtual const uint8_t *bytes() const = 0;
};
class Script final : public Input {
  const std::string text_;
 public:
  explicit Script(std::string text) : text_(std::move(text)) {}
  size_t length() const override { return text_.size(); }
  const uint8_t *bytes() const override {
    return reinterpret_cast<const uint8_t *>(text_.data());
  }
};

// facebook::jsi::Value::ValueKind. Symbol, BigInt, String and Object own a PointerValue.
namespace kind {
constexpr uint32_t undefined = 0;
constexpr uint32_t symbol = 4;
constexpr uint32_t bigint = 5;
constexpr uint32_t string = 6;
constexpr uint32_t object = 7;
}  // namespace kind

// PointerValue::invalidate() is the first virtual function of the host's reference-counted handle.
inline void release(uintptr_t handle) noexcept {
  if (!handle) return;
  auto table = *reinterpret_cast<void ***>(handle);
  reinterpret_cast<void (*)(void *) noexcept>(table[0])(reinterpret_cast<void *>(handle));
}

// facebook::jsi::Pointer and its subclasses (Object, Function, String, PropNameID): one handle, released on
// destruction. The non-trivial destructor makes the compiler return it through a hidden pointer, as the host does.
struct Handle {
  uintptr_t ptr;
  Handle() noexcept : ptr(0) {}
  Handle(Handle &&other) noexcept : ptr(other.ptr) { other.ptr = 0; }
  Handle(const Handle &) = delete;
  Handle &operator=(const Handle &) = delete;
  ~Handle() noexcept { release(ptr); }
  uintptr_t take() noexcept { uintptr_t value = ptr; ptr = 0; return value; }
};

// facebook::jsi::Value: a 32-bit kind, padding, then an eight-byte payload.
struct Value {
  uint32_t tag;
  uint32_t padding;
  uintptr_t payload;
  Value() noexcept : tag(kind::undefined), padding(0), payload(0) {}
  Value(uint32_t tagValue, uintptr_t handle) noexcept : tag(tagValue), padding(0), payload(handle) {}
  Value(Value &&other) noexcept : tag(other.tag), padding(0), payload(other.payload) {
    other.tag = kind::undefined;
    other.payload = 0;
  }
  Value(const Value &) = delete;
  Value &operator=(const Value &) = delete;
  ~Value() noexcept {
    if (tag >= kind::symbol && tag <= kind::object) release(payload);
  }
};
static_assert(sizeof(void *) == 8, "Korg supports 64-bit Apple platforms only");
static_assert(sizeof(Value) == 16 && offsetof(Value, payload) == 8, "jsi::Value is 16 bytes");
static_assert(sizeof(Handle) == 8, "jsi::Pointer is one pointer");
static_assert(!std::is_trivially_destructible<Value>::value && !std::is_trivially_destructible<Handle>::value,
              "Both must be returned indirectly, like the host's classes");
static_assert(sizeof(std::shared_ptr<const Input>) == 16, "shared_ptr is a pointer pair");

// facebook::jsi::HostFunctionType
using HostFunction = std::function<Value(Runtime &, const Value &, const Value *, size_t)>;

// Slots in the virtual table of facebook::jsi::Runtime (React Native 0.86 / Hermes 1.0, jsi.h md5 5c81e771).
// Slot 0 is ICast::castInterface, so there is no destructor before evaluateJavaScript; the destructors come last.
// Every slot below was checked against the vtable inside Discord 353's hermesvm.framework.
namespace slot {
constexpr size_t castInterface = 0;
constexpr size_t evaluateJavaScript = 1;   // 2 prepareJavaScript, 3 evaluatePreparedJavaScript: do NOT call these
constexpr size_t global = 6;
constexpr size_t createPropNameIDFromAscii = 19;
constexpr size_t createStringFromUtf8 = 34;   // String createStringFromUtf8(const uint8_t *, size_t)
constexpr size_t utf8OfString = 36;        // std::string utf8(const String &)
constexpr size_t setPropertyValueByName = 54;  // setPropertyValue(const Object &, const PropNameID &, const Value &)
constexpr size_t createFunctionFromHostFunction = 79;
constexpr size_t completeDestructor = 109;  // followed by the deleting destructor
constexpr size_t count = 111;
}  // namespace slot

template <class Function>
inline Function method(Runtime *runtime, size_t index) {
  auto table = *reinterpret_cast<void ***>(runtime);
  return reinterpret_cast<Function>(table[index]);
}

// Looks up an exported symbol of the host process (dlsym on a device).
using Lookup = void *(*)(const char *);

// Compares the host's exported jsi::Runtime vtable with the layout above. Returns "" when they agree, otherwise
// the reason they do not; the loader must not call into the runtime in that case.
//
// The base class implements some virtual functions itself, and those are exported, so the vtable can be compared
// with real function addresses at points spread over its whole length. An inserted or removed virtual function
// anywhere would shift every anchor after it. The anchors below were read out of Discord 353's hermesvm.framework.
struct Anchor {
  size_t slot;
  const char *symbol;
};
inline const std::vector<Anchor> &layoutAnchors() {
  static const std::vector<Anchor> anchors = {
      {0, "_ZN8facebook3jsi7Runtime13castInterfaceERKNS0_4UUIDE"},
      {9, "_ZN8facebook3jsi7Runtime15instrumentationEv"},
      {12, "_ZN8facebook3jsi7Runtime18setRuntimeDataImplERKNS0_4UUIDEPKvPFvS6_E"},
      {13, "_ZN8facebook3jsi7Runtime18getRuntimeDataImplERKNS0_4UUIDE"},
      {21, "_ZN8facebook3jsi7Runtime25createPropNameIDFromUtf16EPKDsm"},
      {35, "_ZN8facebook3jsi7Runtime21createStringFromUtf16EPKDsm"},
      {37, "_ZN8facebook3jsi7Runtime23createValueFromJsonUtf8EPKhm"},
      {42, "_ZN8facebook3jsi7Runtime25createObjectWithPrototypeERKNS0_5ValueE"},
      {47, "_ZN8facebook3jsi7Runtime14getPrototypeOfERKNS0_6ObjectE"},
      {50, "_ZN8facebook3jsi7Runtime11getPropertyERKNS0_6ObjectERKNS0_5ValueE"},
      {53, "_ZN8facebook3jsi7Runtime11hasPropertyERKNS0_6ObjectERKNS0_5ValueE"},
      {56, "_ZN8facebook3jsi7Runtime16setPropertyValueERKNS0_6ObjectERKNS0_5ValueES7_"},
      {59, "_ZN8facebook3jsi7Runtime14deletePropertyERKNS0_6ObjectERKNS0_5ValueE"},
      {75, "_ZN8facebook3jsi7Runtime8detachedERKNS0_11ArrayBufferE"},
      {78, "_ZN8facebook3jsi7Runtime4pushERKNS0_5ArrayEPKNS0_5ValueEm"},
      {83, "_ZN8facebook3jsi7Runtime8popScopeEPNS0_8IRuntime10ScopeStateE"},
      {92, "_ZN8facebook3jsi7Runtime13getStringDataERKNS0_6StringEPvPFvS5_bPKvmE"},
      {98, "_ZN8facebook3jsi7Runtime6lengthERKNS0_10TypedArrayE"},
      {105, "_ZN8facebook3jsi7Runtime17createSyntaxErrorERKNS0_6StringE"},
      {108, "_ZN8facebook3jsi7Runtime6lengthERKNS0_6StringE"},
  };
  return anchors;
}
inline std::string checkLayout(Lookup lookup) {
  auto table = static_cast<void **>(lookup("_ZTVN8facebook3jsi7RuntimeE"));
  if (!table) return "facebook::jsi::Runtime's virtual table is not exported by the host";
  void **entries = table + 2;  // skip offset-to-top and the type_info pointer
  for (const Anchor &anchor : layoutAnchors()) {
    void *expected = lookup(anchor.symbol);
    if (!expected) return std::string("the host does not export ") + anchor.symbol;
    if (entries[anchor.slot] != expected) return "virtual table slot " + std::to_string(anchor.slot) + " is not " + anchor.symbol;
  }
  // evaluateJavaScript through isInspectable (slots 1-8) are pure virtual in the base class: one shared stub.
  if (!entries[1]) return "slot 1 is empty";
  for (size_t index = 2; index <= 8; ++index)
    if (entries[index] != entries[1]) return "slots 1-8 are not the expected pure virtual functions";
  // The destructors follow the last anchor. Clang fills them in; GCC leaves an abstract class's entries null.
  void *complete = lookup("_ZN8facebook3jsi7RuntimeD1Ev");
  void *deleting = lookup("_ZN8facebook3jsi7RuntimeD0Ev");
  void *first = entries[slot::completeDestructor];
  void *second = entries[slot::completeDestructor + 1];
  bool filled = first == complete && second == deleting;
  bool omitted = !first && !second;
  if (!filled && !omitted) return "the destructors are not at slots 109 and 110";
  return "";
}

// evaluateJavaScript(const std::shared_ptr<const Buffer> &, const std::string &sourceURL). A JavaScript exception
// is thrown as facebook::jsi::JSError (a std::exception whose what() is the message plus the stack).
inline void evaluate(Runtime *runtime, const std::string &source,
                     const std::string &url = "korg://embedded/bootstrap.js") {
  using Evaluate = Value (*)(Runtime *, const std::shared_ptr<const Input> &, const std::string &);
  std::shared_ptr<const Input> input = std::make_shared<Script>(source);
  Value result = method<Evaluate>(runtime, slot::evaluateJavaScript)(runtime, input, url);
  (void)result;
}

// Receives every string JavaScript passes to the installed native function.
using Sink = void (*)(const std::string &);
inline Sink &sinkSlot() {
  static Sink sink = nullptr;
  return sink;
}

// Reads argument `index` as a UTF-8 string. False when it is missing or is not a string.
inline bool stringArgument(Runtime &runtime, const Value *args, size_t count, size_t index, std::string &out) {
  if (index >= count || args[index].tag != kind::string) return false;
  using Utf8 = std::string (*)(Runtime *, const Handle &);
  // A String is just its handle, which sits in the Value's payload.
  out = method<Utf8>(&runtime, slot::utf8OfString)(&runtime, *reinterpret_cast<const Handle *>(&args[index].payload));
  return true;
}

// Builds a JavaScript string value. `text` must be valid UTF-8.
inline Value makeString(Runtime &runtime, const std::string &text) {
  using Create = Handle (*)(Runtime *, const uint8_t *, size_t);
  Handle handle = method<Create>(&runtime, slot::createStringFromUtf8)(
      &runtime, reinterpret_cast<const uint8_t *>(text.data()), text.size());
  return Value(kind::string, handle.take());
}

inline Value reportEntry(Runtime &runtime, const Value &, const Value *args, size_t count) {
  try {
    std::string text;
    if (stringArgument(runtime, args, count, 0, text))
      if (Sink sink = sinkSlot()) sink(text);
  } catch (...) {
    // An exception must never cross back into the engine from a diagnostics call.
  }
  return Value();
}

// Persistent key/value storage that the loader provides to the JavaScript runtime. Discord has no AsyncStorage of its
// own to borrow, and anything the runtime found in Discord's modules could be wiped by the app, so Korg keeps its
// own. Implementations are supplied by the platform code (files on a device, a map in the test harness).
struct Storage {
  bool (*get)(const std::string &key, std::string &value);                  // false when the key does not exist
  std::string (*set)(const std::string &key, const std::string &value);     // "" on success, otherwise the reason
  std::string (*remove)(const std::string &key);                            // "" on success, otherwise the reason
  std::string (*keys)();                                                    // a JSON array of every key
};
inline const Storage *&storageSlot() {
  static const Storage *storage = nullptr;
  return storage;
}

// storage(operation, key, value): one native function, so the JavaScript side has one thing to look for.
//   "get"    -> the stored string, or undefined when there is none
//   "set"    -> undefined on success, otherwise a string describing the failure
//   "remove" -> undefined on success, otherwise a string describing the failure
//   "keys"   -> a JSON array of the stored keys
inline Value storageEntry(Runtime &runtime, const Value &, const Value *args, size_t count) {
  try {
    const Storage *storage = storageSlot();
    std::string operation, key, value;
    if (!stringArgument(runtime, args, count, 0, operation)) return Value();
    if (!storage) return makeString(runtime, "native storage is not installed");
    stringArgument(runtime, args, count, 1, key);
    if (operation == "get") {
      std::string stored;
      return storage->get(key, stored) ? makeString(runtime, stored) : Value();
    }
    if (operation == "set") {
      if (!stringArgument(runtime, args, count, 2, value)) return makeString(runtime, "the value must be a string");
      std::string failure;
      try { failure = storage->set(key, value); } catch (...) { failure = "native storage threw an exception"; }
      return failure.empty() ? Value() : makeString(runtime, failure);
    }
    if (operation == "remove") {
      std::string failure;
      try { failure = storage->remove(key); } catch (...) { failure = "native storage threw an exception"; }
      return failure.empty() ? Value() : makeString(runtime, failure);
    }
    if (operation == "keys") {
      std::string listing;
      try { listing = storage->keys(); } catch (...) { listing = "[]"; }
      return makeString(runtime, listing);
    }
    return makeString(runtime, "unknown storage operation");
  } catch (...) {
    return Value();  // Never let an exception cross back into the engine.
  }
}

// Defines globalThis[property] as a native function.
inline void installFunction(Runtime *runtime, const char *property, unsigned parameters, HostFunction function) {
  using Global = Handle (*)(Runtime *);
  using PropName = Handle (*)(Runtime *, const char *, size_t);
  using Create = Handle (*)(Runtime *, const Handle &, unsigned int, HostFunction);
  using SetProperty = void (*)(Runtime *, const Handle &, const Handle &, const Value &);
  Handle global = method<Global>(runtime, slot::global)(runtime);
  Handle name = method<PropName>(runtime, slot::createPropNameIDFromAscii)(runtime, property, std::strlen(property));
  Handle created = method<Create>(runtime, slot::createFunctionFromHostFunction)(runtime, name, parameters, std::move(function));
  Value value(kind::object, created.take());
  method<SetProperty>(runtime, slot::setPropertyValueByName)(runtime, global, name, value);
}
inline void installReporter(Runtime *runtime, const char *property, Sink sink) {
  sinkSlot() = sink;
  installFunction(runtime, property, 1, HostFunction(&reportEntry));
}
inline void installStorage(Runtime *runtime, const char *property, const Storage *storage) {
  storageSlot() = storage;
  installFunction(runtime, property, 3, HostFunction(&storageEntry));
}

// The script that runs before the Korg bundle: it takes the two native functions off the global object (so they are not
// left lying around under their raw names) and hands them to the runtime as one frozen, non-enumerable global. The bundle is appended after it,
// followed by "\n}();\n". The test harness uses this same text, so a mistake here shows up in the tests.
inline const char *bootstrapPrefix() {
  return R"JS(void function(){
var report=globalThis.__korgNativeReport;
var storage=globalThis.__korgNativeStorage;
try{delete globalThis.__korgNativeReport}catch(_){}
try{delete globalThis.__korgNativeStorage}catch(_){}
if(globalThis.__KORG_NATIVE__)return;
Object.defineProperty(globalThis,'__KORG_NATIVE__',{value:Object.freeze({
name:'KorgOriginalLoader',version:'0.2.0-native-original',abi:'jsi-0.86-apple-arm64-v2',
report:typeof report==='function'?report:undefined,
storage:typeof storage==='function'?storage:undefined,
log:function(){if(globalThis.console)console.log.apply(console,arguments)}
}),configurable:false,writable:false});
)JS";
}
}  // namespace korg

#ifndef KORG_ABI_TEST
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <dispatch/dispatch.h>

// Objective-C declarations must remain at global scope.
static NSLock *diagnosticLock;
static NSMutableDictionary *diagnosticState;
static NSMutableArray *javaScriptErrors;
static NSString *previousLaunch;
static BOOL safeMode;
static id activeObserver;
static NSString *const kDiagnosticsKey = @"KorgOriginalDiagnostics";
static NSString *const kErrorsKey = @"KorgOriginalJSErrors";
static NSString *const kInFlightKey = @"KorgOriginalInFlight";

static void persist() {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  [defaults setObject:[diagnosticState copy] forKey:kDiagnosticsKey];
  [defaults setObject:[javaScriptErrors copy] forKey:kErrorsKey];
}
static void report(NSString *phase, NSString *value) {
  [diagnosticLock lock];
  // Identical values are common (every image load retries the hook); skip the disk write for those.
  if (![diagnosticState[phase] isEqual:value]) {
    diagnosticState[phase] = value;
    persist();
  }
  [diagnosticLock unlock];
}
static NSString *clip(NSString *text, NSUInteger limit) {
  if (text.length <= limit) return text;
  return [[text substringToIndex:limit] stringByAppendingString:@"..."];
}
// Remembers a JavaScript error for the diagnostics screen. Errors are written to disk at once because the host
// may crash right after reporting one.
static void addJavaScriptError(NSString *text) {
  [diagnosticLock lock];
  if (![javaScriptErrors.lastObject isEqualToString:text]) {
    [javaScriptErrors addObject:clip(text, 3000)];
    while (javaScriptErrors.count > 10) [javaScriptErrors removeObjectAtIndex:0];
  }
  persist();
  [[NSUserDefaults standardUserDefaults] synchronize];
  [diagnosticLock unlock];
}
// Written before a call into the host runtime and cleared after it. If the app dies in between, the next launch
// skips Korg once instead of crashing again.
static void breadcrumb(NSString *phase) {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  if (phase) [defaults setObject:phase forKey:kInFlightKey]; else [defaults removeObjectForKey:kInFlightKey];
  [defaults synchronize];
}
// Clears the breadcrumb however the scope is left, including by an exception.
struct Crumb {
  explicit Crumb(NSString *phase) { breadcrumb(phase); }
  ~Crumb() { breadcrumb(nil); }
};
// The runtime formats its own status lines (what it found, what it patched, whether the overlay rendered), so the
// native side only has to keep them.
static NSString *summarize(NSString *text) { return clip(text, 1800); }
// Runs on the JavaScript thread whenever the Korg runtime calls the installed native function.
static void javaScriptReport(const std::string &message) {
  @autoreleasepool {
    NSString *text = [[NSString alloc] initWithBytes:message.data() length:message.size() encoding:NSUTF8StringEncoding];
    // Lone surrogates in a JavaScript string come out as invalid UTF-8; keep the report anyway.
    if (!text) text = [[NSString alloc] initWithBytes:message.data() length:message.size() encoding:NSISOLatin1StringEncoding];
    if (!text) return;
    NSRange newline = [text rangeOfString:@"\n"];
    NSString *kind = newline.location == NSNotFound ? text : [text substringToIndex:newline.location];
    NSString *body = newline.location == NSNotFound ? @"" : [text substringFromIndex:newline.location + 1];
    if ([kind isEqualToString:@"error"]) addJavaScriptError(body);
    else if ([kind isEqualToString:@"status"]) report(@"runtime status", summarize(body));
    else if ([kind isEqualToString:@"boot"]) report(@"runtime", clip(body, 400));
  }
}
// ---- Persistent key/value storage for the JavaScript runtime ---------------------------------------------------------
// One small JSON file per key, named by the SHA-256 of the key (keys can be long URLs), holding {"key":...,"value":...}.
// Files live in Application Support/Korg/storage and are replaced atomically, so a crash never leaves half a value.
static NSObject *storageLock;
static NSString *storageDirectory() {
  static NSString *directory;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    if (!base) base = NSTemporaryDirectory();
    directory = [[base stringByAppendingPathComponent:@"Korg"] stringByAppendingPathComponent:@"storage"];
    storageLock = [NSObject new];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
  });
  return directory;
}
static NSString *storagePath(NSString *key) {
  NSData *bytes = [key dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *name = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2 + 5];
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; ++index) [name appendFormat:@"%02x", digest[index]];
  [name appendString:@".json"];
  return [storageDirectory() stringByAppendingPathComponent:name];
}
static NSString *utf8String(const std::string &text) {
  return [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
}
static std::string standardString(NSString *text) {
  // Not UTF8String: that stops at the first NUL, and a stored value may contain one.
  NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
  return bytes.length ? std::string(static_cast<const char *>(bytes.bytes), bytes.length) : std::string();
}
static NSDictionary *storageRecord(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  id parsed = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![parsed isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *record = parsed;
  return [record[@"key"] isKindOfClass:[NSString class]] && [record[@"value"] isKindOfClass:[NSString class]] ? record : nil;
}
static bool nativeStorageGet(const std::string &key, std::string &value) {
  @autoreleasepool {
    NSString *name = utf8String(key);
    if (!name) return false;
    storageDirectory();
    @synchronized(storageLock) {
      NSDictionary *record = storageRecord(storagePath(name));
      if (![record[@"key"] isEqualToString:name]) return false;  // missing, damaged, or another key's file
      value = standardString(record[@"value"]);
      return true;
    }
  }
}
static std::string nativeStorageSet(const std::string &key, const std::string &value) {
  @autoreleasepool {
    NSString *name = utf8String(key);
    NSString *text = utf8String(value);
    if (!name || !text) return "the key and value must be valid UTF-8";
    storageDirectory();
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"key": name, @"value": text} options:0 error:&error];
    if (!data) return standardString(error.localizedDescription ?: @"could not encode the value");
    @synchronized(storageLock) {
      if (![data writeToFile:storagePath(name) options:NSDataWritingAtomic error:&error])
        return standardString(error.localizedDescription ?: @"could not write the file");
    }
    return "";
  }
}
static std::string nativeStorageRemove(const std::string &key) {
  @autoreleasepool {
    NSString *name = utf8String(key);
    if (!name) return "the key must be valid UTF-8";
    storageDirectory();
    NSError *error = nil;
    @synchronized(storageLock) {
      NSString *path = storagePath(name);
      if ([[NSFileManager defaultManager] fileExistsAtPath:path] && ![[NSFileManager defaultManager] removeItemAtPath:path error:&error])
        return standardString(error.localizedDescription ?: @"could not delete the file");
    }
    return "";
  }
}
static std::string nativeStorageKeys() {
  @autoreleasepool {
    NSMutableArray *keys = [NSMutableArray array];
    NSString *directory = storageDirectory();
    @synchronized(storageLock) {
      for (NSString *file in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil]) {
        if (![file hasSuffix:@".json"]) continue;
        NSDictionary *record = storageRecord([directory stringByAppendingPathComponent:file]);
        if (record) [keys addObject:record[@"key"]];
      }
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:keys options:0 error:nil];
    return data ? standardString([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]) : std::string("[]");
  }
}
static const korg::Storage kNativeStorage = {&nativeStorageGet, &nativeStorageSet, &nativeStorageRemove, &nativeStorageKeys};

static NSString *diagnostics() {
  [diagnosticLock lock];
  NSDictionary *state = [diagnosticState copy];
  NSArray *errors = [javaScriptErrors copy];
  [diagnosticLock unlock];
  NSMutableString *text = [NSMutableString stringWithString:
      @"Korg UI: a floating K control, plus a Korg section in Discord settings when that module is found\n\n"];
  NSDictionary *info = [NSBundle mainBundle].infoDictionary;
  [text appendFormat:@"app: Discord %@ (%@)\n", info[@"CFBundleShortVersionString"] ?: @"?", info[@"CFBundleVersion"] ?: @"?"];
  for (NSString *key in @[@"constructor", @"identity", @"safe mode", @"hook", @"callbacks", @"layout", @"reporter", @"storage",
                          @"resource", @"evaluation", @"runtime", @"runtime status", @"last error"]) {
    id value = state[key];
    if (!value && ([key isEqualToString:@"safe mode"] || [key isEqualToString:@"runtime status"])) continue;
    [text appendFormat:@"%@: %@\n", key, value ?: @"pending"];
  }
  [text appendFormat:@"\nJavaScript errors: %lu\n", (unsigned long)errors.count];
  NSUInteger number = 0;
  for (NSString *error in errors.reverseObjectEnumerator) {
    if (++number > 5) break;
    [text appendFormat:@"%lu. %@\n", (unsigned long)number, error];
  }
  if (!errors.count && state[@"runtime"]) [text appendString:@"(none reported by Korg's JavaScript)\n"];
  if (previousLaunch.length) [text appendFormat:@"\nPrevious launch:\n%@\n", previousLaunch];
  return text;
}
@interface KorgDiagnosticWindow : UIWindow
@property(nonatomic, strong) UIButton *control;
@end
@implementation KorgDiagnosticWindow
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  if (self.rootViewController.presentedViewController)
    return [super hitTest:point withEvent:event];
  CGPoint local = [self.control convertPoint:point fromView:self];
  return [self.control pointInside:local withEvent:event]
      ? [super hitTest:point withEvent:event] : nil;
}
@end
@interface KorgDiagnosticController : UIViewController
@end
@implementation KorgDiagnosticController
- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  KorgDiagnosticWindow *window = (KorgDiagnosticWindow *)self.view.window;
  UIEdgeInsets safe = self.view.safeAreaInsets;
  window.control.frame = CGRectMake(self.view.bounds.size.width - safe.right - 74,
                                    safe.top + 56, 64, 44);
}
- (void)showDiagnostics {
  if (self.presentedViewController) return;
  NSString *text = diagnostics();
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Korg diagnostics"
      message:text preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"Copy diagnostics"
      style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
        [UIPasteboard generalPasteboard].string = text;
      }]];
  [alert addAction:[UIAlertAction actionWithTitle:@"Close"
      style:UIAlertActionStyleCancel handler:nil]];
  [self presentViewController:alert animated:YES completion:nil];
}
@end
static KorgDiagnosticWindow *diagnosticWindow;
static void showControl(unsigned attempt) {
  UIWindowScene *scene = nil;
  for (UIScene *candidate in [UIApplication sharedApplication].connectedScenes)
    if ([candidate isKindOfClass:[UIWindowScene class]] &&
        candidate.activationState == UISceneActivationStateForegroundActive) {
      scene = (UIWindowScene *)candidate;
      break;
    }
  if (!scene) {
    if (attempt < 100) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
        dispatch_get_main_queue(), ^{ showControl(attempt + 1); });
    return;
  }
  if (diagnosticWindow.windowScene == scene) { diagnosticWindow.hidden = NO; return; }
  diagnosticWindow.hidden = YES;
  diagnosticWindow = [[KorgDiagnosticWindow alloc] initWithWindowScene:scene];
  diagnosticWindow.frame = scene.coordinateSpace.bounds;
  diagnosticWindow.windowLevel = UIWindowLevelAlert + 1;
  diagnosticWindow.backgroundColor = UIColor.clearColor;
  KorgDiagnosticController *controller = [KorgDiagnosticController new];
  diagnosticWindow.rootViewController = controller;
  controller.view.backgroundColor = UIColor.clearColor;
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setTitle:@"Korg" forState:UIControlStateNormal];
  button.accessibilityLabel = @"Korg diagnostics";
  button.backgroundColor = UIColor.secondarySystemBackgroundColor;
  button.layer.cornerRadius = 12;
  [button addTarget:controller action:@selector(showDiagnostics)
      forControlEvents:UIControlEventTouchUpInside];
  diagnosticWindow.control = button;
  [controller.view addSubview:button];
  diagnosticWindow.hidden = NO;
  [controller.view setNeedsLayout];
}
#import <objc/runtime.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <atomic>
#include <cstdlib>
#include <mutex>

namespace {
using Initialized = void (*)(id, SEL, id, void *);
std::atomic<Initialized> previous{nullptr};
std::atomic<bool> installed{false};
std::mutex installation;

void *lookupSymbol(const char *name) { return dlsym(RTLD_DEFAULT, name); }

NSString *errorText(const std::exception &error) {
  NSString *text = [NSString stringWithUTF8String:error.what()];
  return text ?: @"(error text was not UTF-8)";
}

void inject(void *runtime) {
  if (!runtime) { report(@"evaluation", @"No runtime supplied"); return; }
  @autoreleasepool {
    NSString *file = [[[NSBundle mainBundle] bundlePath]
        stringByAppendingPathComponent:@"KorgResources.bundle/korg.js"];
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfFile:file options:0 error:&error];
    if (!data || !data.length || data.length > 32 * 1024 * 1024) {
      report(@"resource", @"Missing, empty, or oversized script");
      return;
    }
    if (![[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]) {
      report(@"resource", @"Script is not UTF-8");
      return;
    }
    report(@"resource", @"Embedded script loaded");
    // Call into the engine only if its function table is the one this loader was written for. A wrong slot would run a
    // different function (as the first build did, calling prepareJavaScript instead of evaluateJavaScript).
    std::string problem = korg::checkLayout(&lookupSymbol);
    if (!problem.empty()) {
      report(@"layout", [NSString stringWithFormat:@"Not recognized: %s", problem.c_str()]);
      report(@"evaluation", @"Skipped: this Discord's JavaScript engine interface is not the one Korg was built for");
      return;
    }
    report(@"layout", @"Matches the React Native 0.86 / Hermes 1.0 interface");
    korg::Runtime *engine = static_cast<korg::Runtime *>(runtime);
    {
      Crumb crumb(@"installing the JavaScript-to-native reporter");
      try {
        korg::installReporter(engine, "__korgNativeReport", &javaScriptReport);
        report(@"reporter", @"Installed");
      } catch (const std::exception &failure) {
        report(@"reporter", [NSString stringWithFormat:@"Not installed: %@", errorText(failure)]);
      }
    }
    {
      Crumb crumb(@"installing the native storage function");
      try {
        korg::installStorage(engine, "__korgNativeStorage", &kNativeStorage);
        NSArray *stored = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:storageDirectory() error:nil];
        report(@"storage", [NSString stringWithFormat:@"Installed (%lu saved item%s in Application Support/Korg/storage)",
                            (unsigned long)stored.count, stored.count == 1 ? "" : "s"]);
      } catch (const std::exception &failure) {
        report(@"storage", [NSString stringWithFormat:@"Not installed: %@", errorText(failure)]);
      }
    }
    report(@"evaluation", @"Evaluating on runtime callback thread");
    // The function body isolates local declarations; void forces undefined. The runtime keeps its own preferences
    // through the native storage function; it does not look for storage inside Discord's modules.
    std::string source = korg::bootstrapPrefix();
    source.append(static_cast<const char *>(data.bytes), data.length);
    source.append("\n}();\n");
    {
      Crumb crumb(@"running the Korg bootstrap script");
      try {
        korg::evaluate(engine, source);
        report(@"evaluation", @"Bootstrap script ran without a JavaScript error");
      } catch (const std::exception &failure) {
        report(@"evaluation", @"Bootstrap script threw a JavaScript error (see below)");
        addJavaScriptError([NSString stringWithFormat:@"bootstrap: %@", errorText(failure)]);
      }
    }
  }
}

void initialized(id host, SEL selector, id instance, void *runtime) {
  [diagnosticLock lock];
  diagnosticState[@"callbacks"] = @([diagnosticState[@"callbacks"] unsignedLongLongValue] + 1);
  [diagnosticLock unlock];
  report(@"evaluation", @"Runtime callback received");
  // Do not dispatch runtime work: this callback already owns the JS thread.
  // Install Metro setters before the host delegate can start its application.
  if (safeMode) {
    report(@"evaluation", @"Skipped once: the previous launch ended while Korg was running (see Previous launch)");
  } else {
    try {
      @try {
        inject(runtime);
      } @catch (NSException *error) {
        report(@"evaluation", @"Bootstrap failed");
        report(@"last error", [NSString stringWithFormat:@"Objective-C exception: %@", clip(error.reason ?: error.name, 600)]);
      }
    } catch (const std::exception &error) {
      report(@"evaluation", @"Bootstrap failed");
      report(@"last error", [NSString stringWithFormat:@"C++ exception: %@", clip(errorText(error), 600)]);
    } catch (...) {
      report(@"evaluation", @"Bootstrap failed");
      report(@"last error", @"Unknown C++ exception during bootstrap");
    }
  }
  // Injection failure must not suppress the host's initialization callback.
  auto original = previous.load(std::memory_order_acquire);
  if (original) original(host, selector, instance, runtime);
}

bool compatible(Method method) {
  if (method_getNumberOfArguments(method) != 4) return false;
  char *result = method_copyReturnType(method);
  char *instance = method_copyArgumentType(method, 2);
  char *runtime = method_copyArgumentType(method, 3);
  bool valid = result && std::strcmp(result, "v") == 0 && instance &&
      std::strcmp(instance, "@") == 0 && runtime && runtime[0] == '^' &&
      std::strstr(runtime, "Runtime") != nullptr;
  free(result);
  free(instance);
  free(runtime);
  return valid;
}

bool install() {
  std::lock_guard<std::mutex> lock(installation);
  if (installed.load(std::memory_order_acquire)) return true;
  Class host = objc_lookUpClass("RCTHost");
  SEL selector = sel_registerName("instance:didInitializeRuntime:");
  Method method = host ? class_getInstanceMethod(host, selector) : nullptr;
  if (!method) { report(@"hook", @"Waiting for RCTHost callback method"); return false; }
  if (!compatible(method)) {
    report(@"hook", @"Refused incompatible RCTHost callback signature");
    return false;
  }
  IMP replacement = reinterpret_cast<IMP>(&initialized);
  previous.store(reinterpret_cast<Initialized>(method_getImplementation(method)),
                 std::memory_order_release);
  // Adding an override avoids changing a superclass's method when inherited.
  if (!class_addMethod(host, selector, replacement, method_getTypeEncoding(method))) {
    Method own = class_getInstanceMethod(host, selector);
    IMP displaced = method_setImplementation(own, replacement);
    previous.store(reinterpret_cast<Initialized>(displaced), std::memory_order_release);
  }
  installed.store(true, std::memory_order_release);
  report(@"hook", @"Original RCTHost runtime observer installed");
  return true;
}

void retry(unsigned attempt) {
  if (install()) return;
  if (attempt == 200) {
    report(@"hook", @"Not installed after 20s; future image loads will retry");
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{ retry(attempt + 1); });
}

void imageAdded(const struct mach_header *, intptr_t) {
  if (installed.load(std::memory_order_acquire)) return;
  // Never ask Objective-C to realize classes while dyld holds its image lock.
  dispatch_async(dispatch_get_main_queue(), ^{ install(); });
}

__attribute__((constructor)) void start() {
  @autoreleasepool {
    diagnosticLock = [NSLock new];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    // Summarize the previous launch before replacing its snapshot: a crash leaves its last words here.
    NSMutableString *earlier = [NSMutableString string];
    NSString *interrupted = [defaults stringForKey:kInFlightKey];
    NSDictionary *oldState = [defaults dictionaryForKey:kDiagnosticsKey];
    NSArray *oldErrors = [defaults arrayForKey:kErrorsKey];
    if (interrupted) [earlier appendFormat:@"The app ended while Korg was %@.\n", interrupted];
    if (oldState[@"runtime"]) [earlier appendFormat:@"Last runtime message: %@\n", oldState[@"runtime"]];
    if (oldState[@"runtime status"]) [earlier appendFormat:@"%@\n", oldState[@"runtime status"]];
    NSUInteger shownBefore = 0;
    for (NSString *old in oldErrors.reverseObjectEnumerator) {
      if (++shownBefore > 3) break;
      [earlier appendFormat:@"Error: %@\n", clip(old, 500)];
    }
    previousLaunch = [earlier copy];
    safeMode = interrupted != nil;
    if (safeMode) [defaults removeObjectForKey:kInFlightKey];
    javaScriptErrors = [NSMutableArray new];
    // Replace the persisted snapshot: previous launches must not look current.
    diagnosticState = [@{@"constructor": @"Loaded this session", @"identity": @"Checking",
        @"hook": @"Pending", @"callbacks": @0, @"resource": @"Not requested", @"layout": @"Not checked",
        @"reporter": @"Not installed", @"storage": @"Not installed", @"evaluation": @"Not started", @"last error": @"None"} mutableCopy];
    if (safeMode) diagnosticState[@"safe mode"] = [NSString stringWithFormat:@"Korg skipped this launch because the last one ended while it was %@", interrupted];
    report(@"constructor", @"Loaded this session");
    // Match the executable as well as the ID: IPA signers may change the ID.
    NSBundle *bundle = [NSBundle mainBundle];
    bool discord = [[bundle bundleIdentifier] isEqualToString:@"com.hammerandchisel.discord"] ||
        [[bundle objectForInfoDictionaryKey:@"CFBundleExecutable"] isEqualToString:@"Discord"];
    report(@"identity", discord ? @"Discord identity accepted" : @"Identity rejected");
    if (!discord) return;
    dispatch_async(dispatch_get_main_queue(), ^{
      activeObserver = [[NSNotificationCenter defaultCenter]
          addObserverForName:UIApplicationDidBecomeActiveNotification object:nil
          queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *notification) {
            showControl(0);
          }];
      showControl(0);
    });
    install();
    _dyld_register_func_for_add_image(&imageAdded);
    dispatch_async(dispatch_get_main_queue(), ^{ retry(0); });
  }
}
} // namespace
#endif