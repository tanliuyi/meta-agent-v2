export function NotificationList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="builtin-notification-list">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  );
}
