import type { MultiSelectView } from "./components/multi-select-view";
import type { OptionListViewProps } from "./components/option-list-view";
import type { PreviewPane } from "./components/preview/preview-pane";
import type { StatefulView } from "./stateful-view";

export interface TabBodyHeights {
	current: number;
	max: number;
}

export interface TabComponents {
	optionList: StatefulView<OptionListViewProps>;
	preview: PreviewPane;
	multiSelect?: MultiSelectView;
	bodyHeights: (width: number) => TabBodyHeights;
}
