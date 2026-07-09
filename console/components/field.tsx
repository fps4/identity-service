import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A labelled input for the management forms. */
export function Field({ name, label, type = 'text', placeholder, required, defaultValue }: {
  name: string; label: string; type?: string; placeholder?: string; required?: boolean; defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} placeholder={placeholder} required={required} defaultValue={defaultValue} className="w-56" />
    </div>
  );
}

/** A labelled native <select>, styled to match Field. */
export function SelectField({ name, label, options, required, defaultValue }: {
  name: string; label: string; options: { value: string; label: string }[]; required?: boolean; defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** A hidden form value — used to carry ids (clientId, inviteId, email) into per-row action forms. */
export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

/**
 * A checkbox group for choosing app-scoped roles from an application's catalogue (ADR-0019). Each box
 * submits under the shared `name` (default `roles`), read server-side via FormData.getAll. Uncontrolled:
 * pre-selected boxes use `defaultChecked` so the surrounding ActionForm can submit without local state.
 */
export function RoleCheckboxes({ catalogue, selected = [], name = 'roles', label = 'Roles' }: {
  catalogue: { key: string; name?: string }[];
  selected?: string[];
  name?: string;
  label?: string;
}) {
  if (!catalogue.length) {
    return <p className="text-xs text-muted-foreground">No roles in this application’s catalogue.</p>;
  }
  const chosen = new Set(selected);
  return (
    <fieldset className="flex flex-col gap-1">
      {label ? <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {catalogue.map((r) => (
          <label key={r.key} className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" name={name} value={r.key} defaultChecked={chosen.has(r.key)} />
            <span>{r.name || r.key}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
