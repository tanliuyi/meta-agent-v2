interface ProviderBuiltInModelValueProps {
  label: string;
  value: string;
  code?: boolean;
}

export function ProviderBuiltInModelValue({ label, value, code = false }: ProviderBuiltInModelValueProps) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}
