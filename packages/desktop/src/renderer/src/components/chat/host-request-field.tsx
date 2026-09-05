import * as RadioGroup from "@radix-ui/react-radio-group";
import type { HostRequest } from "../../../../shared/contracts.ts";

interface HostRequestFieldProps {
  request: HostRequest;
  value: string;
  onChange(value: string): void;
}

function isCustomAnswerOption(option: string): boolean {
  return /^\d+\.\s*Type something\.$/i.test(option.trim()) || option.trim() === "Type something.";
}

/** 根据宿主请求类型渲染选择、单行输入或多行编辑字段。 */
export function HostRequestField({ request, value, onChange }: HostRequestFieldProps) {
  if (request.type === "confirm") return null;
  if (request.type === "select") {
    const customOption = request.options?.find(isCustomAnswerOption);
    const options = request.options?.filter((option) => !isCustomAnswerOption(option));
    return (
      <div className="grid gap-1 pt-1">
        <RadioGroup.Root
          className="grid gap-1"
          value={customOption && value === "" ? undefined : value}
          orientation="vertical"
          aria-label={`${request.title} 选项`}
          onValueChange={onChange}
        >
          {options?.map((option, index) => (
            <RadioGroup.Item
              autoFocus={index === 0}
              className="rounded-lg border px-2.5 py-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-accent"
              key={option}
              value={option}
            >
              {option}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        {customOption ? (
          <div className="rounded-lg border px-2.5 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/50">
            <label className="mb-0.5 block text-xs font-medium">自定义回答</label>
            <input
              className="h-8 w-full bg-transparent text-sm outline-none"
              aria-label="自定义回答"
              value={options?.includes(value) ? "" : value}
              placeholder="请输入自定义回答"
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
        ) : null}
      </div>
    );
  }
  return request.type === "editor" ? (
    <textarea
      className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={request.title}
      autoFocus
      rows={10}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <input
      className="mt-2 h-9 w-full rounded-xl border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={request.title}
      autoFocus
      value={value}
      placeholder={request.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
