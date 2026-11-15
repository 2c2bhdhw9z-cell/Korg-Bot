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
inline Value reportEntry(Runtime &runtime, const Value &, const Value *args, size_t count) {
  try {
    if (count > 0 && args[0].tag == kind::string) {
      using Utf8 = std::string (*)(Runtime *, const Handle &);
      // A String is just its handle, which sits in the Value's payload.
      std::string text = method<Utf8>(&runtime, slot::utf8OfString)(
          &runtime, *reinterpret_cast<const Handle *>(&args[0].payload));
      if (Sink sink = sinkSlot()) sink(text);
    }
  } catch (...) {
    // An exception must never cross back into the engine from a diagnostics call.
  }
  return Value();
}

// Defines globalThis[property] as a native function taking one string.
inline void installReporter(Runtime *runtime, const char *property, Sink sink) {
  using Global = Handle (*)(Runtime *);
  using PropName = Handle (*)(Runtime *, const char *, size_t);
  using Create = Handle (*)(Runtime *, const Handle &, unsigned int, HostFunction);
  using SetProperty = void (*)(Runtime *, const Handle &, const Handle &, const Value &);
  sinkSlot() = sink;
  Handle global = method<Global>(runtime, slot::global)(runtime);
  Handle name = method<PropName>(runtime, slot::createPropNameIDFromAscii)(runtime, property, std::strlen(property));
  Handle function = method<Create>(runtime, slot::createFunctionFromHostFunction)(runtime, name, 1, HostFunction(&reportEntry));
  Value value(kind::object, function.take());
  method<SetProperty>(runtime, slot::setPropertyValueByName)(runtime, global, name, value);
}
}  // namespace korg

#ifndef KORG_ABI_TEST
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
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
static NSString *flag(id value) { return [value respondsToSelector:@selector(boolValue)] && [value boolValue] ? @"yes" : @"no"; }
static NSString *summarize(NSString *json) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![parsed isKindOfClass:[NSDictionary class]]) return clip(json, 400);
  NSDictionary *root = parsed;
  NSDictionary *metro = [root[@"metro"] isKindOfClass:[NSDictionary class]] ? root[@"metro"] : @{};
  NSDictionary *hooks = [metro[@"hooks"] isKindOfClass:[NSDictionary class]] ? metro[@"hooks"] : @{};
  NSDictionary *ui = [root[@"ui"] isKindOfClass:[NSDictionary class]] ? root[@"ui"] : @{};
  NSMutableString *line = [NSMutableString string];
  [line appendFormat:@"Metro hooks __d=%@ __r=%@, modules seen: %@", flag(hooks[@"__d"]), flag(hooks[@"__r"]),
      metro[@"moduleCount"] ?: @0];
  if ([metro[@"error"] isKindOfClass:[NSString class]]) [line appendFormat:@", Metro error: %@", metro[@"error"]];
  [line appendFormat:@"\nUI phase=%@ attached=%@ root wrapped=%@", ui[@"phase"] ?: @"?", flag(ui[@"attached"]), flag(ui[@"rootWrapped"])];
  if ([ui[@"reason"] isKindOfClass:[NSString class]]) [line appendFormat:@"\nUI note: %@", ui[@"reason"]];
  return line;
}
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
static NSString *diagnostics() {
  [diagnosticLock lock];
  NSDictionary *state = [diagnosticState copy];
  NSArray *errors = [javaScriptErrors copy];
  [diagnosticLock unlock];
  NSMutableString *text = [NSMutableString stringWithString:
      @"Korg UI is a floating control; not yet a Discord settings row\n\n"];
  NSDictionary *info = [NSBundle mainBundle].infoDictionary;
  [text appendFormat:@"app: Discord %@ (%@)\n", info[@"CFBundleShortVersionString"] ?: @"?", info[@"CFBundleVersion"] ?: @"?"];
  for (NSString *key in @[@"constructor", @"identity", @"safe mode", @"hook", @"callbacks", @"layout", @"reporter",
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
    report(@"evaluation", @"Evaluating on runtime callback thread");
    // The function body isolates local declarations; void forces undefined.
    // The runtime owns storage and UI integration through the host's modules.
    std::string source = R"JS(void function(){
if(globalThis.__KORG_NATIVE__)return;
var report=globalThis.__korgNativeReport;
try{delete globalThis.__korgNativeReport}catch(_){}
Object.defineProperty(globalThis,'__KORG_NATIVE__',{value:Object.freeze({
name:'KorgOriginalLoader',version:'0.2.0-native-original',abi:'jsi-0.86-apple-arm64-v2',storage:'host',
report:typeof report==='function'?report:undefined,
log:function(){if(globalThis.console)console.log.apply(console,arguments)}
}),configurable:false,writable:false});
)JS";
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
        @"reporter": @"Not installed", @"evaluation": @"Not started", @"last error": @"None"} mutableCopy];
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