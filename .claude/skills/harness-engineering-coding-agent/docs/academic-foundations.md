# Academic and Technical Foundations

Author: André Almeida

## Why this document exists

Harness Engineering Coding Agent is an applied operating method, not an academic framework claiming formal validation as a whole. Its credibility comes from combining several well-established research and engineering lines into a practical workflow for AI coding agents.

The central claim is modest and operational: **AI coding agents perform better and more safely when they work inside a structured harness of product intent, specification, context control, task decomposition, verification, release discipline, observability and handoff**. Current research does not prove this exact repository as a controlled intervention. It does, however, strongly supports the individual components that the skill combines.

> The skill should be read as an evidence-informed engineering method: grounded in research on LLM agents, real-world software engineering benchmarks, requirements engineering, behavior-driven development, runtime verification, DevSecOps, SRE and Human-AI collaboration.

## Foundation matrix

| Foundation | What the literature shows | How it appears in the skill | Key references |
|---|---|---|---|
| Real-world coding is not snippet completion | Benchmarks based on GitHub issues show that real software tasks require repository understanding, multi-file edits, environment execution and test feedback. | The skill requires context loading, Git safety, task breakdown, sensors, evaluation reports and handoff. | SWE-bench [^swebench] |
| LLM agents need tools, planning and feedback | Surveys on LLM-based agents for software engineering describe agents as systems that combine planning, memory, tool use, perception, action and interaction. | The workflow is organized as classify, specify, load context, modify, verify, evaluate and hand off. | Liu et al. [^liu-se-agents], Jin et al. [^jin-agents], ReAct [^react], Reflexion [^reflexion] |
| Code can serve as an agent harness | Agentic systems increasingly use code not only as final output, but as infrastructure for reasoning, tool use, memory, environment modeling, verification and shared artifacts. | The skill treats coding work as an operational harness of intent, specification, context, sensors, release discipline, observability, update consent and handoff. | Ning et al. [^code-as-harness] |
| Human oversight remains necessary | Human-AI development environments can improve productivity, but introduce risks of over-reliance, verification burden, correctness issues, maintenance concerns and security problems. | The skill uses explicit acceptance criteria, review-pair mode, evaluation reports, approval gates and transparent handoff. | Sergeyuk et al. [^hax-ide] |
| Requirements must be traceable | Requirements traceability links intent, decisions, implementation and validation, reducing ambiguity and improving maintainability. | Requirement IDs, `CONTRACT.md`, `PRD.md`, `DECISION_LOG.md`, `TEST_PLAN.md` and `EVALUATION_REPORT.md` preserve traceability. | Ramesh et al. [^ramesh-traceability] |
| Behavior should be specified before implementation | BDD uses structured natural language to make behavior understandable by stakeholders and executable or verifiable against software. | `ACCEPTANCE_CRITERIA.md`, behavior contracts and `SEMANTIC_SPEC.md` convert intent into observable behavior. | Binamungu et al. [^bdd-quality] |
| Operational behavior needs runtime evidence | Runtime verification and observability emphasize traces, monitors, signals and evidence of system behavior under execution. | Release gates require logs, metrics, traces, replay/audit checks and known blind spots. | D'Angelo et al. [^runtime-verification], Google SRE [^sre-monitoring] |
| Security belongs in the delivery lifecycle | DevSecOps integrates security practices, tools and metrics into development and operations instead of treating security as a late review. | `security-data` classification, explicit approval for unsafe actions, secrets discipline and stronger validation for sensitive work. | Zhao, Clear and Lal [^devsecops] |
| Critical questioning improves decision quality | Adversarial clarification and design review expose hidden assumptions before implementation, especially when dependencies between decisions are unclear. | `DECISION_GRILL.md`, grill protocol and review-pair/squad roles force the agent to inspect evidence first and ask only blocking questions. | Grill-me pattern [^grill-me] |

## Implication for the skill design

The skill deliberately avoids presenting coding agents as autonomous developers that should simply be trusted. It treats them as powerful but fallible participants inside a software delivery system. The practical implication is that the agent must produce evidence, not just code.

| Skill mechanism | Research-informed rationale |
|---|---|
| Product intent gate | Prevents locally correct code from solving the wrong problem. |
| Specification gate | Turns ambiguous requests into explicit contracts, acceptance criteria and tests. |
| Semantic specification gate | Makes behavior, state, guarantees, constraints and replay/audit needs explicit before architecture hardens. |
| Context loading gate | Reduces irrelevant context while forcing the agent to inspect the codebase where facts already exist. |
| Feedback sensors | Separates deterministic verification from inferential critique. |
| Harness telemetry | Records context used, gate decisions, sensor effectiveness, blind spots and improvement candidates so the harness can improve without silent regression. |
| Review-pair and squad modes | Reduces self-confirmation by separating implementation and evaluation roles. |
| Release gate | Connects code change to production blast radius, rollback, observability and ownership. |
| Handoff | Preserves traceability and continuity across humans, sessions and agents. |
| Decision grill | Forces unresolved branches of the design tree into the open before coding begins. |

## What the research does not yet prove

It would be inaccurate to claim that this exact workflow has already been proven by a peer-reviewed benchmark. The stronger claim is that the workflow is a synthesis of individually supported practices. A future validation path would be to run the same set of real GitHub issues with and without this skill, comparing resolution rate, regression rate, test quality, number of user clarifications, time to completion and quality of handoff.

| Claim | Evidence status |
|---|---|
| Coding agents need tool use, planning and feedback. | Strong support in agent and software engineering literature. |
| Real-world repository tasks are much harder than isolated code generation. | Strong support from SWE-bench and related benchmarks. |
| Human oversight and verification are necessary in AI-assisted IDEs. | Strong support from HAX and empirical literature. |
| Requirements, traceability and BDD reduce ambiguity. | Strong support from software engineering literature. |
| This exact skill improves outcomes across all agents and codebases. | Plausible, but not yet directly benchmarked. |

## Recommended benchmark for future validation

A credible evaluation could select 20 to 50 real GitHub issues across different stacks and run comparable coding agents in two conditions: baseline agent instructions and agent plus Harness Engineering Coding Agent. The evaluation should compare not only success rate, but also quality of tests, regression risk, number of changed files, reviewer effort, correctness of assumptions, quality of handoff and ability to resume work after interruption.

| Metric | Why it matters |
|---|---|
| Issue resolution rate | Measures functional success against real tasks. |
| Test pass rate and test relevance | Separates superficial fixes from verified behavior. |
| Regression count | Captures hidden damage introduced by the agent. |
| Clarification count | Measures whether the agent asks only useful blocking questions. |
| Handoff quality | Measures continuity across sessions and agents. |
| Harness telemetry completeness | Measures whether context, gate decisions, sensor effectiveness, blind spots and improvement candidates were recorded. |
| Reviewer intervention effort | Measures whether the harness reduces or increases human burden. |
| Security and data handling issues | Measures whether safety gates catch sensitive risks. |

## References

[^swebench]: Jimenez, C. E. et al. [SWE-bench: Can Language Models Resolve Real-World GitHub Issues?](https://arxiv.org/abs/2310.06770), ICLR 2024.
[^liu-se-agents]: Liu, J. et al. [A Survey on Large Language Model based Autonomous Agents for Software Engineering](https://arxiv.org/abs/2409.02977), ACM Transactions on Software Engineering and Methodology, 2025.
[^jin-agents]: Jin, Y. et al. [From LLMs to LLM-based Agents for Software Engineering: A Survey of Current, Challenges and Future](https://arxiv.org/abs/2408.02479), 2024.
[^react]: Yao, S. et al. [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629), 2022.
[^reflexion]: Shinn, N. et al. [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366), NeurIPS 2023.
[^hax-ide]: Sergeyuk, A. et al. [Human-AI Experience in Integrated Development Environments: A Systematic Literature Review](https://arxiv.org/abs/2503.06195), Empirical Software Engineering, 2026.
[^code-as-harness]: Ning et al. [Code as Agent Harness](https://arxiv.org/abs/2605.18747), arXiv, 2026.
[^ramesh-traceability]: Ramesh, B. and Jarke, M. [Toward Reference Models for Requirements Traceability](https://doi.org/10.1109/32.605760), IEEE Transactions on Software Engineering, 2001.
[^bdd-quality]: Binamungu, L. P., Embury, S. M. and Konstantinou, N. [Characterising the Quality of Behaviour Driven Development Specifications](https://pmc.ncbi.nlm.nih.gov/articles/PMC7251619/), 2020.
[^runtime-verification]: D'Angelo, B. et al. [A survey of challenges for runtime verification from advanced application domains](https://doi.org/10.1007/s10703-019-00337-w), Formal Methods in System Design, 2019.
[^sre-monitoring]: Google. [Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/), Site Reliability Engineering, 2016.
[^devsecops]: Zhao, X., Clear, T. and Lal, R. [Identifying the primary dimensions of DevSecOps: A multi-vocal literature review](https://www.sciencedirect.com/science/article/pii/S0164121224001080), Journal of Systems and Software, 2024.
[^grill-me]: Matt Pocock. [`grill-me` skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md), GitHub, accessed 2026-05-29.

## Change history

| Date | Time | Reason |
|---|---|---|
| 2026-06-04 | 12:17 GMT-3 | Added Code as Agent Harness foundation and harness telemetry as an evidence target for future validation. |
| 2026-05-29 | 06:05 GMT-3 | Initial academic and technical foundations document, including the critical interview pattern inspired by `grill-me`. |
