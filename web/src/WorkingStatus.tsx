import { useWorkingActivity } from './OperationActivity';

export function WorkingStatus({ active, title, detail = 'Please wait. Keep this page open; this action is already in progress.', mutation = false, track = true, id: anchor }: {
  active: boolean;
  title: string;
  detail?: string;
  mutation?: boolean;
  track?: boolean;
  id?: string;
}) {
  const id = useWorkingActivity(active && track, title, mutation, undefined, anchor);
  return (
    <div id={anchor ?? id} tabIndex={-1} className="working-status" role="status" aria-live="polite" aria-atomic="true">
      {active && <>
        <span className="work-spinner" aria-hidden="true" />
        <div><strong>{title}</strong><p>{detail}</p></div>
      </>}
    </div>
  );
}
