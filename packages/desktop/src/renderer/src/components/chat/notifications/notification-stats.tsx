export function NotificationStats({ items }: { items: readonly { label: string; value: string | number }[] }) {
  return (
    <dl className="builtin-notification-stats">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
