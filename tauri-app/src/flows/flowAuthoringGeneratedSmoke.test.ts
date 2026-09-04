import { describe, expect, it } from 'vitest';
import { compileCatalogSource } from './flowCatalog';
import type { FlowSource } from './types';

function compileGeneratedFlow(source: string) {
  const flowSource: FlowSource = {
    id: 'generated_flow',
    label: 'Generated Flow',
    scope: 'global',
    source,
  };
  return compileCatalogSource(flowSource, 'predefined');
}

describe('generated flow authoring smoke cases', () => {
  it('compiles a branch-parallel audit flow before synthesis', () => {
    const flow = compileGeneratedFlow(`flow:
  id: parallel_audit_report
  label: Parallel Audit Report

inputs:
  input:
    type: string

registry:
  - id: core.audit_check@1
    label: Audit Check
    params:
      request: string
      check_type: string
    parent: root
    returns:
      verdict:
        - pass
        - fail
      summary: string
    prompt: |
      Run the requested check type against the user's request.

      Request:
      {{ request }}

      Check type:
      {{ check_type }}

      End with:

      verdict: pass | fail
      summary: <brief result>

  - id: core.audit_reporter@1
    label: Audit Reporter
    params:
      request: string
      checks: agent[]
    parent: root
    requiresFinalizedCommit: true
    prompt: |
      Combine these audit check results into one risk report artifact.

      Request:
      {{ request }}

      Checks:
      {{ checks }}

      Save the final report as a file and produce a finalized commit.

nodes:
  - use: core.audit_check@1
    as: AuditCheck

  - use: core.audit_reporter@1
    as: AuditReporter

  - use: core.handoff@1
    as: Handoff

run:
  - set: audit_checks
    parallel:
      branches:
        - call: AuditCheck
          parent: root
          args:
            request: input.input
            check_type: dependency audit check
        - call: AuditCheck
          parent: root
          args:
            request: input.input
            check_type: lint check
        - call: AuditCheck
          parent: root
          args:
            request: input.input
            check_type: targeted test check

  - set: audit_report
    call: AuditReporter
    parent: root
    args:
      request: input.input
      checks: audit_checks

  - if: audit_report.commit == null
    then:
      stop: audit_report_missing_commit

  - set: handoff
    call: Handoff
    parent: audit_report
    args:
      request: input.input
      phase: audit handoff
      source_nodes: audit_report
      review: "dependency, lint, and targeted-test audit report created"
      focus: "Summarize the combined risk report and list the concrete checks the user should inspect."
`);

    expect(flow.issues).toEqual([]);
  });
});
