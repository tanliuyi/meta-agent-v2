interface ProviderBuiltInMetadataSectionProps {
  title: string;
  value: object | undefined;
}

export function ProviderBuiltInMetadataSection({ title, value }: ProviderBuiltInMetadataSectionProps) {
  const entries = value ? Object.entries(value) : [];
  return (
    <fieldset className="models-fieldset providers-builtin-model-section">
      <legend>{title}</legend>
      {entries.length > 0 ? (
        <dl className="providers-builtin-model-metadata">
          {entries.map(([key, entryValue]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <code>{typeof entryValue === "string" ? entryValue : JSON.stringify(entryValue)}</code>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="providers-builtin-model-empty">未配置</p>
      )}
    </fieldset>
  );
}
