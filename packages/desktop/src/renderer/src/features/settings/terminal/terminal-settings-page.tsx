import { TERMINAL_FONT_FAMILY_LABEL_ID, TerminalFontFamilyControl } from "./terminal-font-family-control.tsx";
import { TERMINAL_FONT_SIZE_LABEL_ID, TerminalFontSizeControl } from "./terminal-font-size-control.tsx";
import { TERMINAL_SHELL_LABEL_ID, TerminalShellControl } from "./terminal-shell-control.tsx";

/** 承载终端外观与 Shell 配置。 */
export function TerminalSettingsPage() {
  return (
    <div className="settings-content">
      <header className="settings-page-heading">
        <h2>终端</h2>
      </header>
      <section className="settings-section" aria-labelledby="terminal-appearance-heading">
        <div className="settings-section-heading">
          <h3 id="terminal-appearance-heading">外观</h3>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={TERMINAL_FONT_FAMILY_LABEL_ID}>终端字体</span>
            <p className="settings-row-description">输入自定义字体族，回车确认；清空恢复系统默认字体</p>
          </div>
          <TerminalFontFamilyControl />
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={TERMINAL_FONT_SIZE_LABEL_ID}>终端字号</span>
            <p className="settings-row-description">终端面板的文字大小，仅影响终端，不随界面字号缩放</p>
          </div>
          <TerminalFontSizeControl />
        </div>
      </section>
      <section className="settings-section mt-4" aria-labelledby="terminal-shell-heading">
        <div className="settings-section-heading">
          <h3 id="terminal-shell-heading">Shell</h3>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span id={TERMINAL_SHELL_LABEL_ID}>终端 Shell 路径</span>
            <p className="settings-row-description">
              新开终端使用的 Shell 可执行文件绝对路径，支持 ~ 开头；留空回退到项目设置或系统默认
            </p>
          </div>
          <TerminalShellControl />
        </div>
      </section>
    </div>
  );
}
