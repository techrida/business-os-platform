'use client';

import type { DepartmentChange } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  departmentRevisionAction,
  previewDepartmentPeopleAction,
  saveDepartmentPeopleAction,
} from '@/app/(app)/settings/departments/actions';
import { ReviewChangesDialog } from '@/components/access/review-changes-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './departments.module.css';
import type { DepartmentRef } from './people-model';

/**
 * "Add to department" for one person with no department. Choosing the department reads its
 * current access revision, then the change goes through the same review dialog as the People card
 * (a membership decides what the person sees).
 */
export function AddToDepartment({
  person,
  departments,
}: {
  person: { id: string; name: string };
  departments: readonly DepartmentRef[];
}) {
  const router = useRouter();
  const [pickOpen, setPickOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<{ department: DepartmentRef; revision: string } | null>(
    null,
  );
  const changes: DepartmentChange[] =
    review === null
      ? []
      : [{ kind: 'memberAdd', departmentId: review.department.id, userId: person.id }];

  async function next() {
    const department = departments.find((d) => d.id === departmentId);
    if (department === undefined) return;
    setPending(true);
    const result = await departmentRevisionAction(department.id);
    setPending(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setPickOpen(false);
    setReview({ department, revision: result.revision });
  }

  return (
    <>
      <Button
        variant="secondary"
        size="small"
        aria-label={`Add ${person.name} to a department`}
        disabled={departments.length === 0}
        onClick={() => {
          setDepartmentId('');
          setPickOpen(true);
        }}
      >
        Add to department
      </Button>
      <Dialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        title={`Add ${person.name} to a department`}
        size="small"
        locked={pending}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={pending || departmentId === ''}
              aria-busy={pending || undefined}
              onClick={() => void next()}
            >
              Review changes
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <Field label="Department">
            {(control) => (
              <Select
                {...control}
                name="departmentId"
                required
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
              >
                <option value="">Choose a department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
      {review !== null && (
        <ReviewChangesDialog
          open
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={`Review changes to ${review.department.name}`}
          changes={changes}
          expectedRevision={review.revision}
          runPreview={(list) => previewDepartmentPeopleAction(list)}
          runSave={({ acknowledged, note }) =>
            saveDepartmentPeopleAction(review.department.id, {
              changes,
              expectedRevision: review.revision,
              acknowledged: [...acknowledged],
              note,
            })
          }
          onSaved={() => {
            setReview(null);
            router.refresh();
          }}
          onStale={() => {
            setReview(null);
            toast.error('Access was changed by someone else. Reload to see the latest.');
            router.refresh();
          }}
        />
      )}
    </>
  );
}
