export default function Loading() {
  return (
    <div className="page-loading" role="status">
      <span className="loading-dot" />
      <p>Loading workspace…</p>
      <span>The API may take a moment to wake up.</span>
    </div>
  );
}
