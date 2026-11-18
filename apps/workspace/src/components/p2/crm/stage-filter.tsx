'use client';

import type { OpportunityStage } from '@bos/contracts';
import * as Popover from '@radix-ui/react-popover';
import Form from 'next/form';
import { useRouter } from 'next/navigation';
import { useOptimistic, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';

import styles from './stage-filter.module.css';

type StageOption = { value: OpportunityStage; label: string };

export function OpportunityFilters({
  view,
  query,
  selection,
  options,
}: {
  view: 'table' | 'board';
  query: string;
  selection: readonly OpportunityStage[];
  options: readonly StageOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stages, setStages] = useOptimistic(selection);

  function updateStages(next: readonly OpportunityStage[]) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    for (const stage of next) params.append('stage', stage);
    startTransition(() => {
      setStages(next);
      router.push(params.size > 0 ? `/opportunities?${params.toString()}` : '/opportunities', {
        scroll: false,
      });
    });
  }

  return (
    <Form action="/opportunities" scroll={false} className={styles.toolbar} role="search">
      {view === 'board' ? <input type="hidden" name="view" value="board" /> : null}
      {stages.map((stage) => (
        <input key={stage} type="hidden" name="stage" value={stage} />
      ))}
      <Field label="Search opportunities" className={styles.search ?? ''}>
        {(control) => (
          <Input
            key={query}
            name="q"
            type="search"
            defaultValue={query}
            maxLength={100}
            {...control}
          />
        )}
      </Field>
      <Button type="submit" variant="secondary">
        Search
      </Button>
      {view === 'table' ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              className={styles.trigger}
              data-filtered={stages.length > 0}
              aria-label={stages.length > 0 ? `Stage, ${stages.length} selected` : 'Stage'}
            >
              Stage
              {stages.length > 0 ? (
                <Badge tone="info" aria-hidden="true">
                  {stages.length}
                </Badge>
              ) : null}
              <Icon name="chevron-down" size={16} />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label="Filter by stage"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className={styles.popover}
            >
              {options.map(({ value, label }) => (
                <label key={value} className={styles.option}>
                  <input
                    type="checkbox"
                    checked={stages.includes(value)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      updateStages(
                        options
                          .filter((option) =>
                            option.value === value ? checked : stages.includes(option.value),
                          )
                          .map((option) => option.value),
                      );
                    }}
                  />
                  {label}
                </label>
              ))}
              <div className={styles.footer}>
                <Button
                  variant="ghost"
                  size="small"
                  aria-disabled={stages.length === 0}
                  onClick={() => {
                    if (stages.length > 0) updateStages([]);
                  }}
                >
                  Clear stages
                </Button>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      <span className="sr-only" role="status">
        {pending ? 'Updating opportunities' : ''}
      </span>
    </Form>
  );
}
