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
