import { useAui } from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import {
  type ComponentPropsWithoutRef,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn.ts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

export interface ModelSelectorEffortOption {
  id: string;
  name: string;
}

export const DEFAULT_EFFORT_OPTIONS: readonly ModelSelectorEffortOption[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Med" },
  { id: "high", name: "High" },
];

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: readonly string[];
  efforts?: boolean | readonly ModelSelectorEffortOption[];
}

function getModelEfforts(model: ModelOption | undefined): readonly ModelSelectorEffortOption[] | undefined {
  if (!model?.efforts) return undefined;
  return model.efforts === true ? DEFAULT_EFFORT_OPTIONS : model.efforts;
}

function resolveEffort(
  efforts: readonly ModelSelectorEffortOption[] | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined;
  return efforts?.some((option) => option.id === effort) ? effort : undefined;
}

export function resolveModelEffort(
  models: readonly ModelOption[],
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  return resolveEffort(getModelEfforts(models.find((model) => model.id === modelId)), effort);
}

function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop: T | undefined;
  defaultProp: T | undefined;
  onChange: ((next: T) => void) | undefined;
}) {
  const [internal, setInternal] = useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : internal;
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChangeRef.current?.(next);
    },
    [isControlled],
  );
  return [value, setValue] as const;
}

interface ModelSelectorContextValue {
  models: readonly ModelOption[];
  value: string | undefined;
  setValue(value: string): void;
  selectedModel: ModelOption | undefined;
  efforts: readonly ModelSelectorEffortOption[] | undefined;
  effort: string | undefined;
  setEffort(effort: string): void;
  setOpen(open: boolean): void;
}

const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(null);

function useModelSelectorContext() {
  const context = useContext(ModelSelectorContext);
  if (!context) throw new Error("ModelSelector sub-components must be used within ModelSelector.Root");
  return context;
}

export function useModelSelectorEfforts() {
  const { efforts, effort, setEffort } = useModelSelectorContext();
  return { efforts, effort, setEffort };
}

export interface ModelSelectorRootProps {
  models: readonly ModelOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  effort?: string;
  defaultEffort?: string;
  onEffortChange?(effort: string): void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
}

function ModelSelectorRoot({
  models,
  value: valueProp,
  defaultValue,
  onValueChange,
  effort: effortProp,
  defaultEffort,
  onEffortChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
}: ModelSelectorRootProps) {
  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? models[0]?.id,
    onChange: onValueChange,
  });
  const [effort, setEffort] = useControllableState({
    prop: effortProp,
    defaultProp: defaultEffort,
    onChange: onEffortChange,
  });
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });
  const selectedModel = models.find((model) => model.id === value);
  const efforts = getModelEfforts(selectedModel);
  const activeEffort = resolveEffort(efforts, effort);
  const contextValue = useMemo(
    () => ({
      models,
      value,
      setValue,
      selectedModel,
      efforts,
      effort: activeEffort,
      setEffort,
      setOpen,
    }),
    [models, value, setValue, selectedModel, efforts, activeEffort, setEffort, setOpen],
  );

  return (
    <ModelSelectorContext.Provider value={contextValue}>
      <Popover open={open ?? false} onOpenChange={setOpen}>
        {children}
      </Popover>
    </ModelSelectorContext.Provider>
  );
}

export const modelSelectorTriggerVariants = cva(
  "flex w-fit max-w-40 items-center justify-between gap-1.5 overflow-hidden rounded-md text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        muted: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
      size: {
        default: "h-8 px-2.5 py-1.5",
        sm: "h-7 px-2 py-1 text-xs",
        lg: "h-9 px-3 py-2",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export type ModelSelectorTriggerProps = ComponentPropsWithoutRef<typeof PopoverTrigger> &
  VariantProps<typeof modelSelectorTriggerVariants>;

function ModelSelectorTrigger({ className, variant, size, children, onKeyDown, ...props }: ModelSelectorTriggerProps) {
  const { setOpen } = useModelSelectorContext();
  return (
    <PopoverTrigger
      data-slot="model-selector-trigger"
      data-variant={variant ?? "outline"}
      data-size={size ?? "default"}
      role="combobox"
      aria-haspopup="listbox"
      className={cn(modelSelectorTriggerVariants({ variant, size }), className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        }
      }}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
    </PopoverTrigger>
  );
}

export interface ModelSelectorValueProps {
  placeholder?: ReactNode;
  showEffort?: boolean;
  className?: string;
}

function ModelIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5", className)}>
      {children}
    </span>
  );
}

function ModelSelectorValue({ placeholder = "选择模型", showEffort = true, className }: ModelSelectorValueProps) {
  const { selectedModel, efforts, effort } = useModelSelectorContext();
  if (!selectedModel) {
    return (
      <span data-slot="model-selector-value" className={cn("text-muted-foreground", className)}>
        {placeholder}
      </span>
    );
  }
  const effortName =
    showEffort && effort !== undefined ? efforts?.find((option) => option.id === effort)?.name : undefined;
  return (
    <span data-slot="model-selector-value" className={cn("flex min-w-0 items-center gap-2", className)}>
      {selectedModel.icon ? <ModelIcon>{selectedModel.icon}</ModelIcon> : null}
      <span className="truncate font-medium">{selectedModel.name}</span>
      {effortName ? <span className="min-w-7.5 truncate text-center text-muted-foreground">{effortName}</span> : null}
    </span>
  );
}

export type ModelSelectorContentProps = ComponentPropsWithoutRef<typeof PopoverContent> & { searchable?: boolean };

function ModelSelectorFocusAnchor() {
  return (
    <div className="sr-only">
      <CommandInput readOnly aria-label="模型" />
    </div>
  );
}

function ModelSelectorContent({
  className,
  align = "start",
  sideOffset = 6,
  searchable,
  children,
  ...props
}: ModelSelectorContentProps) {
  const { value } = useModelSelectorContext();
  const unfiltered = searchable === false || (!searchable && children === undefined);
  return (
    <PopoverContent
      data-slot="model-selector-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "w-64 min-w-(--radix-popover-trigger-width) overflow-hidden rounded-lg bg-popover/95 p-0 shadow-lg backdrop-blur-sm",
        className,
      )}
      {...props}
    >
      <Command shouldFilter={!unfiltered} {...(value !== undefined ? { defaultValue: value } : {})}>
        {unfiltered ? <ModelSelectorFocusAnchor /> : null}
        {children ?? (
          <>
            {searchable ? <ModelSelectorSearch /> : null}
            <ModelSelectorList />
            <ModelSelectorEffort />
          </>
        )}
      </Command>
    </PopoverContent>
  );
}

export type ModelSelectorSearchProps = ComponentPropsWithoutRef<typeof CommandInput>;

function ModelSelectorSearch({ placeholder = "搜索模型...", ...props }: ModelSelectorSearchProps) {
  return <CommandInput data-slot="model-selector-search" placeholder={placeholder} {...props} />;
}

export type ModelSelectorListProps = ComponentPropsWithoutRef<typeof CommandList>;

function ModelSelectorList({ className, children, ...props }: ModelSelectorListProps) {
  const { models } = useModelSelectorContext();
  return (
    <CommandList
      data-slot="model-selector-list"
      className={cn(
        "max-h-64 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <ModelSelectorEmpty />
          <CommandGroup>
            {models.map((model) => (
              <ModelSelectorItem key={model.id} model={model} />
            ))}
          </CommandGroup>
        </>
      )}
    </CommandList>
  );
}

export type ModelSelectorEmptyProps = ComponentPropsWithoutRef<typeof CommandEmpty>;

function ModelSelectorEmpty({ children, ...props }: ModelSelectorEmptyProps) {
  return (
    <CommandEmpty data-slot="model-selector-empty" {...props}>
      {children ?? "未找到模型"}
    </CommandEmpty>
  );
}

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<typeof CommandGroup>;
function ModelSelectorGroup(props: ModelSelectorGroupProps) {
  return <CommandGroup data-slot="model-selector-group" {...props} />;
}

export type ModelSelectorSeparatorProps = ComponentPropsWithoutRef<typeof CommandSeparator>;
function ModelSelectorSeparator(props: ModelSelectorSeparatorProps) {
  return <CommandSeparator data-slot="model-selector-separator" {...props} />;
}

export type ModelSelectorItemProps = Omit<ComponentPropsWithoutRef<typeof CommandItem>, "value"> & {
  model: ModelOption;
};

function ModelSelectorItem({ model, className, children, onSelect, ...props }: ModelSelectorItemProps) {
  const { value, setValue, setOpen } = useModelSelectorContext();
  const isSelected = value === model.id;
  return (
    <CommandItem
      data-slot="model-selector-item"
      value={model.id}
      keywords={[model.name, ...(model.keywords ?? [])]}
      disabled={model.disabled}
      onSelect={(selectedValue) => {
        setValue(model.id);
        setOpen(false);
        onSelect?.(selectedValue);
      }}
      className={cn(
        "relative mx-1 items-start gap-1.5 rounded-md py-1.5 ps-2 pe-7 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon ? <ModelIcon>{model.icon}</ModelIcon> : null}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{model.name}</span>
            {model.description ? (
              <span className="truncate text-[10px] text-muted-foreground">{model.description}</span>
            ) : null}
          </span>
        </>
      )}
      {isSelected ? (
        <span className="absolute end-2 top-2 flex size-3.5 items-center justify-center">
          <Check className="size-4" aria-hidden="true" />
        </span>
      ) : null}
    </CommandItem>
  );
}

export type ModelSelectorEffortProps = ComponentPropsWithoutRef<"div"> & {
  label?: ReactNode;
};

function ModelSelectorEffort({ label = "Thinking", className, onKeyDown, ...props }: ModelSelectorEffortProps) {
  const { efforts, effort, setEffort } = useModelSelectorEfforts();
  if (!efforts?.length) return null;
  return (
    <div
      data-slot="model-selector-effort"
      className={cn("flex items-center justify-between gap-3 border-t px-3 py-2", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Home" || event.key === "End") event.stopPropagation();
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.currentTarget.closest("[cmdk-root]")?.querySelector<HTMLInputElement>("[cmdk-input]")?.focus();
        }
      }}
      {...props}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <RadioGroupPrimitive.Root
        value={effort ?? ""}
        onValueChange={setEffort}
        orientation="horizontal"
        aria-label={typeof label === "string" ? label : "Reasoning effort"}
        className="flex items-center gap-0.5"
      >
        {efforts.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.id}
            value={option.id}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:bg-accent data-[state=checked]:font-medium data-[state=checked]:text-accent-foreground"
          >
            {option.name}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

export type ModelSelectorProps = Omit<ModelSelectorRootProps, "children"> &
  VariantProps<typeof modelSelectorTriggerVariants> & {
    searchable?: boolean;
    align?: ModelSelectorContentProps["align"];
    className?: string;
    contentClassName?: string;
  };

function ModelSelectorModelContext() {
  const { value, effort } = useModelSelectorContext();
  const api = useAui();
  useEffect(() => {
    if (value === undefined) return;
    return api.modelContext().register({
      getModelContext: () => ({
        config: {
          modelName: value,
          ...(effort !== undefined ? { reasoningEffort: effort } : undefined),
        },
      }),
    });
  }, [api, value, effort]);
  return null;
}

function ModelSelectorImpl({
  searchable,
  variant,
  size,
  align,
  className,
  contentClassName,
  ...rootProps
}: ModelSelectorProps) {
  return (
    <ModelSelectorRoot {...rootProps}>
      <ModelSelectorModelContext />
      <ModelSelectorTrigger variant={variant} size={size} className={className} />
      <ModelSelectorContent align={align} className={contentClassName} searchable={searchable ?? false} />
    </ModelSelectorRoot>
  );
}

type ModelSelectorComponent = typeof ModelSelectorImpl & {
  displayName?: string;
  Root: typeof ModelSelectorRoot;
  Trigger: typeof ModelSelectorTrigger;
  Value: typeof ModelSelectorValue;
  Content: typeof ModelSelectorContent;
  Search: typeof ModelSelectorSearch;
  FocusAnchor: typeof ModelSelectorFocusAnchor;
  List: typeof ModelSelectorList;
  Empty: typeof ModelSelectorEmpty;
  Group: typeof ModelSelectorGroup;
  Separator: typeof ModelSelectorSeparator;
  Item: typeof ModelSelectorItem;
  Effort: typeof ModelSelectorEffort;
};

const ModelSelector = memo(ModelSelectorImpl) as unknown as ModelSelectorComponent;
ModelSelector.displayName = "ModelSelector";
ModelSelector.Root = ModelSelectorRoot;
ModelSelector.Trigger = ModelSelectorTrigger;
ModelSelector.Value = ModelSelectorValue;
ModelSelector.Content = ModelSelectorContent;
ModelSelector.Search = ModelSelectorSearch;
ModelSelector.FocusAnchor = ModelSelectorFocusAnchor;
ModelSelector.List = ModelSelectorList;
ModelSelector.Empty = ModelSelectorEmpty;
ModelSelector.Group = ModelSelectorGroup;
ModelSelector.Separator = ModelSelectorSeparator;
ModelSelector.Item = ModelSelectorItem;
ModelSelector.Effort = ModelSelectorEffort;

export {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorEmpty,
  ModelSelectorFocusAnchor,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
  ModelSelectorValue,
};
