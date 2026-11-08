import styles from '../admin.module.css';

export interface UserOption {
  id: string;
  label: string;
}

/**
 * Picks a person by id. With a user list it is a select; without one (the viewer lacks
 * `admin.users.read`, or the list failed) it is a text field for the user's id, so the form still works.
 */
export function UserField({
  id,
  name,
  label,
  users,
  defaultValue = '',
}: {
  id: string;
  name: string;
  label: string;
  users: readonly UserOption[] | null;
  defaultValue?: string;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {users && users.length > 0 ? (
        <select id={id} className={styles.select} name={name} required defaultValue={defaultValue}>
          <option value="" disabled>
            Choose a person
          </option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className={styles.input}
          name={name}
          required
          autoComplete="off"
          placeholder="User id"
          defaultValue={defaultValue}
        />
      )}
    </div>
  );
}
