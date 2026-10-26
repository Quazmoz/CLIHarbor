export function WorkingStatus({ active, title, detail = 'Please wait. Keep this page open; this action is already in progress.' }: {
  active: boolean;
  title: string;
  detail?: string;
}) {
  return (
    <div className="working-status" role="status" aria-live="polite" aria-atomic="true">
      {active && <>
        <span className="work-spinner" aria-hidden="true" />
        <div><strong>{title}</strong><p>{detail}</p></div>
      </>}
    </div>
  );
}
