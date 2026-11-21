#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZoltLock, NSObject)
RCT_EXTERN_METHOD(setEnabled:(BOOL)on after:(double)seconds resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(lock:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
