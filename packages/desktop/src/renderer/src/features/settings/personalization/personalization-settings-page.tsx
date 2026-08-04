import { AVATAR_VISIBILITY_LABEL_ID, AvatarVisibilityControl } from "./avatar-visibility-control.tsx";
import { FONT_FAMILY_LABEL_ID, FontFamilyControl } from "./font-family-control.tsx";
import { FONT_SIZE_LABEL_ID, FontSizeControl } from "./font-size-control.tsx";
import { MESSAGE_WIDTH_LABEL_ID, MessageWidthControl } from "./message-width-control.tsx";
import { RUNNING_AUTO_EXPAND_LABEL_ID, RunningAutoExpandControl } from "./running-auto-expand-control.tsx";
import { THEME_COLOR_LABEL_ID, ThemeColorControl } from "./theme-color-control.tsx";
import { ThemePreferenceControl } from "./theme-preference-control.tsx";
import { THINKING_VISIBILITY_LABEL_ID, ThinkingVisibilityControl } from "./thinking-visibility-control.tsx";
import { UserProfileControl } from "./user-profile-control.tsx";

/** 承载 renderer 的个性化设置项。 */
export function PersonalizationSettingsPage() {
  return (
    <div className="settings-content">
      <header className="settings-page-heading">
        <h2>个性化</h2>
      </header>
      <section className="settings-section" aria-labelledby="user-profile-heading">
        <div className="settings-section-heading">
          <h3 id="user-profile-heading">用户资料</h3>
        </div>
        <UserProfileControl />
      </section>
      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-section-heading">
          <h3 id="appearance-heading">外观</h3>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span>主题</span>
            <p className="settings-row-description">跟随系统，或固定使用浅色 / 深色外观</p>
          </div>
          <ThemePreferenceControl />
        </div>
        <div className="settings-row theme-color-settings-row">
          <div className="settings-row-text">
            <span id={THEME_COLOR_LABEL_ID}>主题色</span>
            <p className="settings-row-description">用于主要操作、选中状态与焦点提示</p>
          </div>
          <ThemeColorControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={FONT_FAMILY_LABEL_ID}>界面字体</span>
            <p className="settings-row-description">输入自定义字体族，回车确认；清空恢复系统默认字体</p>
          </div>
          <FontFamilyControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={FONT_SIZE_LABEL_ID}>界面字号</span>
            <p className="settings-row-description">整体缩放界面文字与控件大小</p>
          </div>
          <FontSizeControl />
        </div>
      </section>
      <section className="settings-section mt-4" aria-labelledby="message-heading">
        <div className="settings-section-heading">
          <h3 id="message-heading">消息</h3>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={THINKING_VISIBILITY_LABEL_ID}>显示 Thinking</span>
            <p className="settings-row-description">在对话中展示模型的思考过程</p>
          </div>
          <ThinkingVisibilityControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={RUNNING_AUTO_EXPAND_LABEL_ID}>运行时自动展开</span>
            <p className="settings-row-description">消息生成期间自动展开 Thinking 与工具调用分组</p>
          </div>
          <RunningAutoExpandControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={MESSAGE_WIDTH_LABEL_ID}>消息宽度</span>
            <p className="settings-row-description">对话中消息列的显示宽度，满屏时占满可用空间</p>
          </div>
          <MessageWidthControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={AVATAR_VISIBILITY_LABEL_ID}>显示头像</span>
            <p className="settings-row-description">在对话中显示模型提供方图标，每轮对话一个</p>
          </div>
          <AvatarVisibilityControl />
        </div>
      </section>
    </div>
  );
}
