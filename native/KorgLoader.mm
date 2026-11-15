// Original Korg loader implementation. See ABI.md for the versioned contract.
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace korg {
// Slot-compatible interface, independently named; no React Native headers used.
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

// A nontrivial destructor is essential: Apple arm64 uses x8 for this return.
// The tag is 32 bits, then padding, then an eight-byte payload (RN 0.80).
struct Result {
  uint32_t kind;
  uint32_t padding;
  uintptr_t payload;
  ~Result() noexcept {
    // Normally undefined (0). Release an unexpected owned result as well.
    if (kind >= 4 && kind <= 7 && payload) {
      void *handle = reinterpret_cast<void *>(payload);
      auto table = *reinterpret_cast<void ***>(handle);
      reinterpret_cast<void (*)(void *) noexcept>(table[0])(handle);
    }
  }
};
static_assert(sizeof(void *) == 8 && sizeof(Result) == 16);
static_assert(offsetof(Result, payload) == 8);
static_assert(!std::is_trivially_destructible<Result>::value);
static_assert(sizeof(std::shared_ptr<const Input>) == 16);
constexpr size_t evaluateSlot = 2;
using Evaluate = Result (*)(void *, const std::shared_ptr<const Input> &,
                           const std::string &);
void evaluate(void *runtime, const std::string &source) {
  auto table = *reinterpret_cast<void ***>(runtime);
  std::shared_ptr<const Input> input = std::make_shared<Script>(source);
  const std::string url = "korg://embedded/bootstrap.js";
  auto result = reinterpret_cast<Evaluate>(table[evaluateSlot])(runtime, input, url);
  (void)result;
}
} // namespace korg

#ifndef KORG_ABI_TEST
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#include <dispatch/dispatch.h>

// Objective-C declarations must remain at global scope.
static NSLock *diagnosticLock;
static NSMutableDictionary *diagnosticState;
static id activeObserver;
static void report(NSString *phase, NSString *value) {
  [diagnosticLock lock];
  diagnosticState[phase] = value;
  [[NSUserDefaults standardUserDefaults] setObject:[diagnosticState copy]
                                           forKey:@"KorgOriginalDiagnostics"];
  [diagnosticLock unlock];
}
static NSString *diagnostics() {
  [diagnosticLock lock];
  NSDictionary *state = [diagnosticState copy];
  [diagnosticLock unlock];
  NSMutableString *text = [NSMutableString stringWithString:
      @"Korg UI is a floating control; not yet a Discord settings row\n\n"];
  for (NSString *key in @[@"constructor", @"identity", @"hook", @"callbacks",
                          @"resource", @"evaluation", @"last error"])
    [text appendFormat:@"%@: %@\n", key, state[key] ?: @"pending"];
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
#include <cstring>
#include <exception>
#include <mutex>

namespace {
using Initialized = void (*)(id, SEL, id, void *);
std::atomic<Initialized> previous{nullptr};
std::atomic<bool> installed{false};
std::mutex installation;

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
    report(@"evaluation", @"Evaluating on runtime callback thread");
    // The function body isolates local declarations; void forces undefined.
    // The runtime owns storage and UI integration through the host's modules.
    std::string source =
        "void function(){\n"
        "if(globalThis.__KORG_NATIVE__)return;\n"
        "Object.defineProperty(globalThis,'__KORG_NATIVE__',{value:Object.freeze({"
        "name:'KorgOriginalLoader',version:'0.2.0-native-original',"
        "abi:'rn-0.80-apple-arm64-v1',storage:'host',"
        "log:function(){if(globalThis.console)console.log.apply(console,arguments)}"
        "}),configurable:false,writable:false});\n";
    source.append(static_cast<const char *>(data.bytes), data.length);
    source.append("\ntry { if(globalThis.console) console.log('[Korg] native probe',"
                  "typeof globalThis.__KORG_INTERNAL__?.ui?.status,"
                  "typeof globalThis.__KORG_DIAGNOSTICS__); } catch (_) {}\n}();\n");
    korg::evaluate(runtime, source);
    report(@"evaluation", @"Bootstrap evaluation returned; UI attachment unverified");
  }
}

void initialized(id host, SEL selector, id instance, void *runtime) {
  [diagnosticLock lock];
  diagnosticState[@"callbacks"] = @([diagnosticState[@"callbacks"] unsignedLongLongValue] + 1);
  [diagnosticLock unlock];
  report(@"evaluation", @"Runtime callback received");
  // Do not dispatch runtime work: this callback already owns the JS thread.
  // Install Metro setters before the host delegate can start its application.
  try {
    @try {
      inject(runtime);
    } @catch (NSException *error) {
      report(@"evaluation", @"Bootstrap failed");
      report(@"last error", @"Objective-C exception during bootstrap (details redacted)");
    }
  } catch (const std::exception &error) {
    report(@"evaluation", @"Bootstrap failed");
    report(@"last error", @"C++ exception during bootstrap (details redacted)");
  } catch (...) {
    report(@"evaluation", @"Bootstrap failed");
    report(@"last error", @"Unknown C++ exception during bootstrap");
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
    // Replace the persisted snapshot: previous launches must not look current.
    diagnosticState = [@{@"constructor": @"Loaded this session", @"identity": @"Checking",
        @"hook": @"Pending", @"callbacks": @0, @"resource": @"Not requested",
        @"evaluation": @"Not started", @"last error": @"None"} mutableCopy];
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