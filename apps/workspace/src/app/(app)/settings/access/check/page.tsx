import type { CheckPersonAreaRow, CheckPersonReport } from '@bos/contracts';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import type { MemberOption } from '@/components/ui/member-picker';
import { Disclosure } from '@/components/ui/disclosure';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, Td, Th } from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import { checkPersonAccess, listAccessPeople, type AccessPersonOption } from '@/lib/api-access';
import type { Session } from '@/lib/session';

import { requireAccess } from '../roles/_lib/guard';
import { loadErrorMessage, type Loaded } from '../roles/_lib/load';
import { LoadError } from '../roles/_lib/load-error';
import { LEVEL_LABEL } from '../roles/_lib/reach';
import {
  actionsText,
  assignText,
  changeHref,
  checkHref,
  headerLine,
  PERSON_NOT_FOUND,
  personNotice,
  personParam,
  PICK_PROMPT,
  visibleText,
} from './check-model';
import styles from './check.module.css';
import { PersonPicker } from './person-picker';

type RawParams = Record<string, string | string[] | undefined>;

type ReportResult =
  | { kind: 'ok'; report: CheckPersonReport }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

async function loadPeople(session: Session): Promise<Loaded<AccessPersonOption[]>> {
  try {
    return { ok: true, data: await listAccessPeople(session) };
  } catch (error) {
    return { ok: false, message: loadErrorMessage(error) };
  }
}

async function loadReport(session: Session, personId: string): Promise<ReportResult> {
  try {
    return { kind: 'ok', report: await checkPersonAccess(session, personId) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'missing' };
    return { kind: 'error', message: loadErrorMessage(error) };
  }
}

/** Picker choices; a person reached by a shared link stays choosable even if the list is empty. */
function personOptions(
  people: readonly AccessPersonOption[],
  report: CheckPersonReport | null,
): MemberOption[] {
  const options: MemberOption[] = people.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.departmentName,
    group: p.departmentName,
    searchText: p.email ?? undefined,
  }));
  if (report && !options.some((o) => o.id === report.person.id)) {
    options.push({
      id: report.person.id,
      name: report.person.name,
      role: report.person.department?.name ?? null,
      group: report.person.department?.name ?? null,
      searchText: report.person.email ?? undefined,
    });
  }
  return options;
}

function CanSee({ row }: { row: CheckPersonAreaRow }) {
  return (
    <span className={styles.reach}>
      <span>{row.scopeLabel}</span>
      <span className={styles.count}>{visibleText(row)}</span>
      {row.previousScopeLabel ? (
        <span className={styles.was}>was {row.previousScopeLabel}</span>
      ) : null}
    </span>
  );
}

function CanAssign({ row }: { row: CheckPersonAreaRow }) {
  const text = assignText(row);
  if (text === null) {
    return (
      <>
        <span aria-hidden="true" className={styles.muted}>
          &mdash;
        </span>
        <span className="sr-only">Not used in this area</span>
      </>
    );
  }
  const people = row.assignablePeople ?? [];
  if (people.length === 0) return <span>{text}</span>;
  return (
    <Disclosure title={text}>
      <ul className={styles.names}>
        {people.map((p) => (
          <li key={p.userId}>
            {p.name}
            <span className={styles.muted}>
              {' · '}
              {LEVEL_LABEL[p.level]}
              {p.departmentName ? ` in ${p.departmentName}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Why({ row }: { row: CheckPersonAreaRow }) {
  return (
    <ul className={styles.why}>
      {row.why.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function ChangeLink({ row, className }: { row: CheckPersonAreaRow; className: string }) {
  return (
    <Link href={changeHref(row)} className={className}>
      Change this<span className="sr-only"> for {row.label}</span>
    </Link>
  );
}

function Report({ report }: { report: CheckPersonReport }) {
  const { person, areas } = report;
  const notice = personNotice(person);
  return (
    <section className={styles.check} aria-labelledby="check-person-header">
      <h2 id="check-person-header" className={styles.header}>
        {headerLine(person)}
      </h2>
      {notice ? (
        <Alert tone={person.roles.length === 0 ? 'info' : 'warning'}>{notice}</Alert>
      ) : null}
      {person.roles.length === 0 ? null : (
        <>
          <div className={styles.table}>
            <Table caption={`What ${person.name} can open`} minWidth={720}>
              <thead>
                <tr>
                  <Th>Area</Th>
                  <Th>Can see</Th>
                  <Th>Can also</Th>
                  <Th>Can assign to</Th>
                  <Th>Why</Th>
                  <Th>
                    <span className="sr-only">Change</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {areas.map((row) => (
                  <tr key={row.area}>
                    <Th scope="row">{row.label}</Th>
                    <Td>
                      <CanSee row={row} />
                    </Td>
                    <Td>{actionsText(row)}</Td>
                    <Td>
                      <CanAssign row={row} />
                    </Td>
                    <Td>
                      <Why row={row} />
                    </Td>
                    <Td nowrap>
                      <ChangeLink row={row} className={styles.change ?? ''} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className={styles.cards} aria-label={`What ${person.name} can open`}>
            {areas.map((row) => (
              <li key={row.area} className={styles.card}>
                <h3 className={styles.cardTitle}>{row.label}</h3>
                <dl className={styles.facts}>
                  <div className={styles.fact}>
                    <dt>Can see</dt>
                    <dd>
                      <CanSee row={row} />
                    </dd>
                  </div>
                  <div className={styles.fact}>
                    <dt>Can also</dt>
                    <dd>{actionsText(row)}</dd>
                  </div>
                  <div className={styles.fact}>
                    <dt>Can assign to</dt>
                    <dd>
                      <CanAssign row={row} />
                    </dd>
                  </div>
                  <div className={styles.fact}>
                    <dt>Why</dt>
                    <dd>
                      <Why row={row} />
                    </dd>
                  </div>
                </dl>
                <ChangeLink row={row} className={styles.cardChange ?? ''} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Access > Check a person (spec 6.2): what one person can see and do in each area, who they can
 * assign work to, and why, from the API's report. A read only: it writes nothing and never signs in
 * as the person. The Access layout draws the page title and the tabs.
 */
export default async function CheckPersonPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const personId = personParam(params['person']);
  const { session } = await requireAccess(checkHref(personId ?? ''));

  const [people, result] = await Promise.all([
    loadPeople(session),
    personId === null ? Promise.resolve(null) : loadReport(session, personId),
  ]);
  const report = result?.kind === 'ok' ? result.report : null;

  return (
    <div className={styles.check}>
      {people.ok ? (
        <PersonPicker options={personOptions(people.data, report)} value={personId ?? ''} />
      ) : (
        <LoadError message={people.message} retryHref={checkHref(personId ?? '')} />
      )}
      {result === null ? (
        <EmptyState title={PICK_PROMPT} icon="user" />
      ) : result.kind === 'missing' ? (
        <Alert tone="warning">{PERSON_NOT_FOUND}</Alert>
      ) : result.kind === 'error' ? (
        <LoadError message={result.message} retryHref={checkHref(personId ?? '')} />
      ) : (
        <Report report={result.report} />
      )}
    </div>
  );
}
