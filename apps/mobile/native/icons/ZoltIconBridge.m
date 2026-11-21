#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZoltIcon, NSObject)
RCT_EXTERN_METHOD(current:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(choose:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
