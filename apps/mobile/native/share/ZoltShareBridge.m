#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZoltShare, NSObject)
RCT_EXTERN_METHOD(syncRecipients:(NSArray *)values resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(listDrafts:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(updateDraft:(NSString *)draftId recipientId:(NSString *)recipientId message:(NSString *)message resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(markDraftSent:(NSString *)draftId threadId:(NSString *)threadId resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(removeDraft:(NSString *)draftId resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(donate:(NSDictionary *)value resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
