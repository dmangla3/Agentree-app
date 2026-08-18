import type { FlowSource } from './types';

export const PREDEFINED_FLOW_SOURCES: FlowSource[] = [
  {
    id: 'parallel_review_until_satisfied',
    label: 'Parallel Synthesis Review',
    scope: 'global',
    source: `flow:
  id: parallel_review_until_satisfied
  label: Parallel Synthesis Review

inputs:
  input:
    type: string
  count:
    type: integer
    default: 3
    min: 1
    max: 5

nodes:
  - use: core.implementer@1
    as: Implementer

  - use: core.synthesizer@1
    as: Synthesizer

  - use: core.reviewer@1
    as: Reviewer

  - use: core.fixer@1
    as: Fixer

run:
  - set: implementations
    parallel:
      count: input.count
      call: Implementer
      args:
        request: input.input
      parent: root

  - set: synthesizer
    call: Synthesizer
    parent: root
    args:
      request: input.input
      candidates: implementations

  - set: implementation
    value: synthesizer

  - set: commit
    value: implementation.commit

  - if: commit == null
    then:
      stop: synthesized_implementation_has_no_commit

  - set: fixer_parent
    value: implementation

  - set: reviewer_parent
    value: implementation

  - set: latest_fix
    value: null

  - loop:
      max_rounds: 3
      steps:
        - set: reviewer
          call: Reviewer
          parent: reviewer_parent
          args:
            request: input.input
            target_node: implementation
            commit: commit
            latest_fix: latest_fix
            criteria: "Review correctness against the original request."

        - if: reviewer.verdict == pass
          then:
            break: true

        - set: fixer
          call: Fixer
          parent: fixer_parent
          args:
            review: reviewer

        - set: commit
          value: fixer.commit

        - set: latest_fix
          value: fixer

        - set: fixer_parent
          value: fixer

        - set: reviewer_parent
          value: reviewer
`,
  },
];
