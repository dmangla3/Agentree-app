import type { FlowSource } from './types';

export const PREDEFINED_FLOW_SOURCES: FlowSource[] = [
  {
    id: 'parallel_review_until_satisfied',
    label: 'Parallel Review Until Satisfied',
    scope: 'global',
    source: `flow:
  id: parallel_review_until_satisfied
  label: Parallel Review Until Satisfied

inputs:
  input:
    type: string
  count:
    type: integer
    default: 3
    min: 1
    max: 5

nodes:
  - id: Implementer
    params: [input]
    parent: root
    prompt: |
      Please implement:
      {{ input }}

  - id: Judge
    params: [implementations, spawn_parent]
    parent: "{{ spawn_parent }}"
    returns:
      selected: node
      verdict: [pass, fail]
    prompt: |
      Compare these implementations and choose the best one:

      {{ implementations }}

      End with:

      selected: <one implementation node>
      verdict: pass | fail

  - id: Reviewer
    params: [input, commit, fixer_node, spawn_parent]
    parent: "{{ spawn_parent }}"
    returns:
      verdict: [pass, fail]
    prompt: |
      Review this implementation against the original request.

      Original request:
      {{ input }}

      Commit:
      {{ commit }}

      Latest fixer response, if any:
      {{ fixer_node }}

      Provide feedback normally.
      End with:

      verdict: pass | fail

  - id: Fixer
    params: [reviewer_node, spawn_parent]
    parent: "{{ spawn_parent }}"
    prompt: |
      Please check this feedback on your implementation.
      You inherit implementation context from your parent.

      Feedback:
      {{ reviewer_node }}

      If you disagree with any feedback, explain why.
      Otherwise implement the fix.

run:
  - set: implementations
    parallel:
      count: input.count
      call: Implementer
      args:
        input: input.input
      parent: root

  - set: judge
    call: Judge
    args:
      implementations: implementations
      spawn_parent: root

  - set: implementation
    value: judge.selected

  - set: commit
    value: implementation.commit

  - if: commit == null
    then:
      stop: selected_implementation_has_no_commit

  - set: fixer_parent
    value: implementation

  - set: reviewer_parent
    value: judge

  - set: fixer_node
    value: null

  - loop:
      max_rounds: 3
      steps:
        - set: reviewer
          call: Reviewer
          args:
            input: input.input
            commit: commit
            fixer_node: fixer_node
            spawn_parent: reviewer_parent

        - if: reviewer.verdict == pass
          then:
            break: true

        - set: fixer
          call: Fixer
          args:
            reviewer_node: reviewer
            spawn_parent: fixer_parent

        - set: commit
          value: fixer.commit

        - set: fixer_node
          value: fixer

        - set: fixer_parent
          value: fixer

        - set: reviewer_parent
          value: reviewer
`,
  },
];
