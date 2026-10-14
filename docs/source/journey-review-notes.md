The user journey I created is mostly correct, but I would not approve it as the final development flow yet. It covers the major modules and operational lifecycle, but a few important transitions and dependencies need to be tightened.

The main issue is not missing modules. It is making sure that every step has a clear starting condition, responsible user, system validation, success outcome and failure/recovery path.

## 1. The most important gaps

| Priority | Gap                                                                    | Required correction                                                                                  |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Critical | Request, approval, reservation and active stay are treated too closely | Keep them as separate states and records with explicit transitions.                                  |
| Critical | Bed availability may change between selection and confirmation         | Revalidate and reserve atomically; handle concurrent requests.                                       |
| Critical | No complete failure-recovery flow                                      | Define what happens when check-in, transfer, checkout or an integration fails midway.                |
| Critical | Checkout, clearance and bed readiness are interconnected               | Track them separately so an employee's exit does not automatically make a bed available.             |
| High     | Eligibility can change after reservation                               | Revalidate at reservation and check-in, with a defined exception process.                            |
| High     | Approval routes are not fully specified                                | Define approvers, delegation, timeouts, rejection, cancellation and escalation per request type.     |
| High     | Notifications are not a complete workflow                              | Define delivery failure, retry, duplicate prevention and in-app status visibility.                   |
| High     | HRMS and manual records can conflict                                   | Define source-of-truth fields, duplicate matching, synchronization failures and conflict resolution. |
| High     | Transfers and extensions have competing reservations                   | Validate future bookings and reserve the destination before releasing the source bed.                |
| High     | Roles may overlap in approval and execution                            | Enforce permission scope and separation of duties on the backend.                                    |

These are corrections and recommendations based on the supplied document and the proposed journey; they are not all explicitly defined in the original document.

## 2. The biggest missing part: the complete accommodation lifecycle

The journey should be structured like this, with separate exception paths at every stage.

### 1

### Configure

Sites, buildings, rooms, beds, policies and permissions

### 2

### Register staff

HRMS/import/manual entry, deduplication and verification

### 3

### Determine eligibility

Validate employee status and accommodation rules

### 4

### Request accommodation

Capture dates, requirements and approval route

### 5

### Allocate a bed

Check availability, restrictions and overlapping reservations

### 6

### Reserve

Complete required approvals and lock the bed against competing requests

### 7

### Check in

Verify identity, room readiness, keys and assets

### 8

### Manage active stay

Requests, maintenance, visitors, facilities and transfers

### 9

### Initiate exit

HR exit, scheduled departure or authorized checkout

### 10

### Complete clearance

Keys, assets, inspection, outstanding items and exceptions

### 11

### Prepare the bed

Cleaning, maintenance and readiness verification

### 12

### Release for reuse

Mark available only when every required condition is satisfied

At each step, define authorization, validation, audit, notification, failure recovery and the next permitted state.

This retains the lifecycle defined in the document while making its dependencies explicit.&#x20;

Staff Accommodation Platform – Roles, Permissions & Module Map.docx



## 3. Additional gaps to resolve before development

These areas need explicit business rules, even though the broad modules already exist.

- Waitlist management: What determines priority? How long does an offer remain valid? What happens when someone declines?
- No-shows and late arrivals: When can a reservation expire, and who can authorize an extension?
- Emergency check-in: What happens if approval is overdue, rejected or the resident cannot be moved immediately?
- Bed swaps and transfers: How are destination capacity, future reservations, key handover and failed transactions handled?
- Charges and deposits: Are rent, damage deductions, waivers, refunds and payroll exports part of phase 1? The source leaves this open.
- Security incidents: Who acknowledges SOS, what happens if nobody responds, and how are escalations closed?
- Data retention: When does checked-out resident access end, what records remain, and who can authorize deletion?
- Operational outages: How does reception operate if the network or HRMS integration is unavailable?
- Acceptance testing: What exact conditions must pass before each workflow is considered complete?

The original document explicitly leaves several organization, finance, maintenance, security and operational decisions for client confirmation. Those should not be silently assumed.&#x20;

Staff Accommodation Platform – Roles, Permissions & Module Map.docx



## 4. My final verdict

Correct at the conceptual level

The major roles, modules and lifecycle stages are covered.

Not yet complete for implementation

Approval routing, transaction safety, exception recovery, waitlist rules and exact acceptance criteria need final definition.

My recommendation: Before creating screens or implementing all the modules, finalize three deliverables:

1. Role-based user journey map — what each user does and which screens they see.
2. Workflow and state-transition specification — what the system does at each step, including errors and exceptions.
3. Business rules and acceptance-test matrix — the validations and expected results developers and QA must implement.

Once those are approved, the development team can build each module against a consistent flow instead of fixing conflicting rules later.