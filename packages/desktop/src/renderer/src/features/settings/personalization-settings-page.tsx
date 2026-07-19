import { ThemePreferenceControl } from "./theme-preference-control.tsx";

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
    </div>
  );
}
