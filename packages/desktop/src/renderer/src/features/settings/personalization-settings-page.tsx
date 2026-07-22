import { ThemePreferenceControl } from "./theme-preference-control.tsx";
import { THINKING_VISIBILITY_LABEL_ID, ThinkingVisibilityControl } from "./thinking-visibility-control.tsx";

/** 承载 renderer 的个性化设置项。 */
export function PersonalizationSettingsPage() {
  return (
    <div className="settings-content">
      <header className="settings-page-heading">
        <h2>个性化</h2>
      </header>
      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-section-heading">
          <h3 id="appearance-heading">外观</h3>
        </div>
        <div className="settings-row">
          <span>主题</span>
          <ThemePreferenceControl />
        </div>
      </section>
      <section className="settings-section mt-4" aria-labelledby="chat-heading">
        <div className="settings-section-heading">
          <h3 id="chat-heading">聊天</h3>
        </div>
        <div className="settings-row">
          <span id={THINKING_VISIBILITY_LABEL_ID}>显示 Thinking</span>
          <ThinkingVisibilityControl />
        </div>
      </section>
    </div>
  );
}
