import * as RadioGroup from "@radix-ui/react-radio-group";
import type { HostRequest } from "../../../../shared/contracts.ts";

interface HostRequestFieldProps {
  request: HostRequest;
  value: string;
  onChange(value: string): void;
}

/** 根据宿主请求类型渲染选择、单行输入或多行编辑字段。 */
export function HostRequestField({ request, value, onChange }: HostRequestFieldProps) {
  if (request.type === "confirm") return null;
  if (request.type === "select") {
    return (
      <RadioGroup.Root
        className="grid gap-1.5 pt-2"
        value={value}
        orientation="vertical"
        aria-label={`${request.title} 选项`}
        onValueChange={onChange}
      >
        {request.options?.map((option) => (
          <RadioGroup.Item
            className="rounded-md border px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-accent"
            key={option}
            value={option}
          >
            {option}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    );
  }
  return request.type === "editor" ? (
    <textarea
      className="mt-2 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={request.title}
      rows={10}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <input
      className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={request.title}
      autoFocus
      value={value}
      placeholder={request.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
