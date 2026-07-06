# AGENTS.md

Write code people can maintain at 2am.

---

# Context Acquisition Rules

To minimize token usage and unnecessary code exploration:

1. Start with the exact file, symbol, or line range requested.
2. Read the enclosing function or type only when the requested context is insufficient to safely complete the task.
3. Read referenced symbols only when their behavior cannot be inferred from the current context.
4. Do not read entire files unless:

   * the target symbol cannot be located, or
   * the change affects multiple symbols throughout the file.
5. Do not perform repository-wide searches unless:

   * explicitly requested, or
   * required to determine the impact of a change.
6. Prefer symbol-based reads over file-based reads.
7. Prefer targeted line ranges over full-file reads.
8. Gather the minimum context necessary to make a safe change.
9. Before expanding context, explain why the currently available context is insufficient.
10. Avoid exploratory reading that is not directly related to the current task.

---

# Change Scope Rules

1. Change only what is required for the task.
2. Do not refactor unrelated code.
3. Do not rename symbols unless required.
4. Do not reformat files unrelated to the change.
5. Do not fix adjacent issues unless explicitly requested.
6. Keep diffs as small as possible.

---

# Evidence Rules

1. Do not assume behavior.
2. Read the implementation before changing it.
3. Verify assumptions from code, not naming.
4. If uncertain, state the uncertainty.
5. Prefer evidence over inference.

---

# Core Rules

* Prefer simple code over clever code.
* Make state and side effects explicit.
* One file, one responsibility.
* One function, one job.
* Delete abstraction until the code becomes harder to change.
* Comments explain why, not what.
* Optimize for readability first, performance second.

---

# Anti-Bloat Rules

Avoid:

* Deep abstraction layers
* Generic utility wrappers with one caller
* Premature optimization
* Enterprise naming (`BaseManagerFactoryService`)
* Configuration-driven code when plain code is clearer
* Large "reusable" modules that solve hypothetical problems
* Classes when functions are sufficient
* Framework patterns applied without a clear need
* AI filler words and long explanations

Prefer:

* Small pure functions
* Flat control flow
* Early returns
* Explicit data flow
* Composition over inheritance
* Modules with obvious names
* Data structures over object hierarchies

If a junior engineer cannot trace the flow in under 2 minutes, simplify it.

---

# File Rules

* Prefer files under ~200 lines.
* Split files when responsibilities diverge or navigation becomes difficult.
* Files should have a single responsibility.
* Files that frequently change together should remain together.
* Avoid dumping unrelated helpers into a single utility file.

Bad:

```text
utils
├── format_date
├── validate_email
└── calculate_tax
```

Good:

```text
date
└── format_date

validation
└── validate_email

tax
└── calculate_tax
```

---

# Function Rules

Functions should:

* Do one thing.
* Be easy to test.
* Avoid hidden state.
* Stay under ~50 lines when practical.
* Prefer deterministic input/output.

Prefer early returns over nested conditionals.

Bad:

```pseudo
function process(user):
    if user:
        if user.isActive:
            save(user)
```

Good:

```pseudo
function process(user):
    if not user:
        return

    if not user.isActive:
        return

    save(user)
```

---

# Naming Rules

Names should explain intent without comments.

Bad:

```pseudo
data = load()
tmp = user.email
flag = true
```

Good:

```pseudo
users = loadUsers()
userEmail = user.email
isProcessing = true
```

Boolean names should read naturally:

```pseudo
if isValid and hasAccess and not isLoading:
```

Avoid abbreviations unless they are standard.

Good:

```text
url
html
db
api
```

Bad:

```text
usr
cfg
respData
```

---

# Comments

Most comments are failed naming.

Do not comment obvious code.

Bad:

```pseudo
# increment count
count = count + 1
```

Good:

```pseudo
# Payment provider may retry events for up to 3 days
```

Comment only when explaining:

* Business rules
* Security constraints
* Performance tradeoffs
* Library or framework workarounds
* Non-obvious decisions

---

# Error Handling

Fail fast.

Do not swallow errors.

Bad:

```pseudo
try:
    return loadUsers()
catch error:
    log(error)
    return []
```

Good:

```pseudo
try:
    return loadUsers()
catch error:
    raise Error("Failed to load users", error)
```

Errors should:

* Include enough context to debug.
* Be handled at the appropriate layer.
* Avoid hiding failures.

---

# Data and Types

* Validate data at system boundaries.
* Trust validated data internally.
* Prefer explicit structures over loosely shaped data.
* Make invalid states difficult or impossible to represent.
* Avoid untyped or ambiguous data passing through the system.

Bad:

```pseudo
function parse(data):
    # accepts anything
```

Good:

```pseudo
function parse(validatedInput):
    # known structure
```

---

# State Management

Prefer passing state explicitly.

Bad:

```pseudo
global currentUser

function getCurrentUser():
    return currentUser
```

Good:

```pseudo
function getCurrentUser(session):
    return session.user
```

Hidden state makes code harder to understand and test.

---

# Async and Concurrency

Use the simplest model that works.

Run independent work in parallel.

```pseudo
user = fetchUser()
settings = fetchSettings()

waitForAll(user, settings)
```

Avoid:

* Unnecessary serialization
* Shared mutable state
* Background work without ownership

Concurrency should be obvious from reading the code.

---

# Database Rules

* Keep queries explicit.
* Prefer SQL when it is clearer than ORM abstractions.
* Transactions should be obvious.
* Validate data before persistence.
* Optimize only after measuring.

---

# Logging Rules

* Log state transitions.
* Log failures with useful context.
* Do not log secrets or sensitive data.
* Avoid duplicate logs across layers.
* Logs should help debug production issues.

---

# Testing

Test behavior, not implementation.

Bad:

```pseudo
assert validateFunctionWasCalled()
```

Good:

```pseudo
assert createUser({}) raises ValidationError
```

Prefer:

* Pure functions
* Deterministic tests
* Minimal mocking

If a test requires excessive setup, simplify the design.

---

# Architecture Rules

Prefer:

```text
Request
  -> Validation
  -> Business Logic
  -> Storage
  -> Response
```

Avoid:

```text
Request
  -> Controller
  -> Service
  -> Manager
  -> Factory
  -> Strategy
  -> Adapter
  -> Repository
  -> Storage
```

Every layer must justify its existence.

A layer that only forwards calls is usually unnecessary.

---

# Dependency Rules

Before adding a dependency:

1. Can the standard library solve it?
2. Is it already present in the project?
3. Is it actively maintained?
4. Does it remove more code than it adds?

Prefer standard library solutions when reasonable.

---

# Interface Rules

1. Define interfaces at the point of use.
2. Do not create interfaces before a second implementation exists.
3. Prefer small interfaces.
4. Accept interfaces, return concrete types.
5. Avoid abstraction for hypothetical future requirements.

---

# Review Checklist

Before merging:

* File responsibilities clear?
* Functions focused?
* Hidden state removed?
* Names obvious?
* Comments necessary?
* Any AI filler language?
* Any abstraction with one caller?
* Any reusable code that is not reused?
* Error paths clear?
* Data validated at boundaries?
* Tests cover behavior?
* Diff limited to the requested change?

---

# The Deletion Test

Before adding code, ask:

1. Can I solve this with existing code?
2. Can I remove code instead?
3. Is this abstraction needed today?
4. Will this make debugging easier at 2am?

If removing code makes the design clearer, remove it.

The best code is not the most clever code.

The best code is the code the next engineer understands immediately.

---
