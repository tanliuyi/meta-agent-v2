export function ThreadSidebarDropZoneSkeleton() {
  return (
    <div className="thread-drop-zone-skeleton">
      <div className="thread-drop-zone-skeleton-header">
        <span className="thread-drop-zone-skeleton-icon" />
        <span className="thread-drop-zone-skeleton-line thread-drop-zone-skeleton-title" />
      </div>
      <div className="thread-drop-zone-skeleton-body">
        <div className="thread-drop-zone-skeleton-group">
          <span className="thread-drop-zone-skeleton-line" />
          <span className="thread-drop-zone-skeleton-line" />
          <span className="thread-drop-zone-skeleton-line" />
        </div>
      </div>
      <div className="thread-drop-zone-skeleton-footer">
        <span className="thread-drop-zone-skeleton-line" />
      </div>
    </div>
  );
}
