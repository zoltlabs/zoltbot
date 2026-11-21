import ActivityKit
import SwiftUI
import WidgetKit

/// P3: the Lock Screen and Dynamic Island view. Counts come from the activity's state; the top
/// request's title comes from the App Group cache the app writes, never from a push.
@main
struct ZoltActivityBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) { ZoltActivityWidget() }
  }
}

@available(iOS 16.2, *)
struct ZoltActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ZoltActivityAttributes.self) { context in
      let top = context.state.top(ZoltActivityCache.read())
      LockView(state: context.state, top: top)
        .padding(16)
        .activityBackgroundTint(nil)
        .widgetURL(ZoltActivityLinks.chat(top))
    } dynamicIsland: { context in
      let top = context.state.top(ZoltActivityCache.read())
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Counts(state: context.state) }
        DynamicIslandExpandedRegion(.bottom) { Request(state: context.state, top: top) }
      } compactLeading: {
        Text("\(context.state.working)").monospacedDigit()
          .accessibilityLabel("\(context.state.working) working")
      } compactTrailing: {
        Text("\(context.state.needsYou)").monospacedDigit().foregroundStyle(.orange)
          .accessibilityLabel("\(context.state.needsYou) need you")
      } minimal: {
        Text("\(context.state.needsYou)").monospacedDigit()
          .accessibilityLabel("\(context.state.needsYou) need you")
      }
      .widgetURL(ZoltActivityLinks.chat(top))
    }
  }
}

@available(iOS 16.2, *)
private struct Counts: View {
  let state: ZoltActivityAttributes.ContentState
  var body: some View {
    Text("\(state.working) working · \(state.needsYou) need you")
      .font(.headline)
      .monospacedDigit()
  }
}

@available(iOS 16.2, *)
private struct Request: View {
  let state: ZoltActivityAttributes.ContentState
  let top: ZoltActivityTop?
  var body: some View {
    // One link: answering happens in the chat, where the whole request is shown.
    if let top {
      Link(destination: ZoltActivityLinks.chat(top)) {
        HStack(alignment: .firstTextBaseline) {
          Text(top.title).font(.subheadline).lineLimit(2)
          Spacer(minLength: 8)
          Text("Open").font(.subheadline.bold())
        }
      }
    }
  }
}

@available(iOS 16.2, *)
private struct LockView: View {
  let state: ZoltActivityAttributes.ContentState
  let top: ZoltActivityTop?
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Counts(state: state)
      Request(state: state, top: top)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
