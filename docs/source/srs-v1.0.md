**SOFTWARE REQUIREMENTS\
SPECIFICATION**

Staff Accommodation Platform

Phase 1 Scope & Implementation Requirements

Prepared by Adpedia Digital Solutions\
Client: Grand Hyatt (client confirmation required)\
Version: 1.0 --- Draft for review and sign-off\
Date: 14 October 2026

  -----------------------------------------------------------------------
  **Document status:** Implementation-ready baseline with explicit
  assumptions and client decisions still requiring confirmation. This
  document does not represent final client approval.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# Document Control

  -----------------------------------------------------------------------
  **Item**                            **Value**
  ----------------------------------- -----------------------------------
  Document purpose                    Define Phase 1 scope, user
                                      journeys, roles, business rules,
                                      state transitions, validations,
                                      data requirements, exception
                                      handling and acceptance tests.

  Primary source                      Staff Accommodation Platform --
                                      Roles, Permissions & Module Map (13
                                      October 2026), plus decisions
                                      supplied in the current
                                      requirements discussion.

  Platform                            One responsive web application; no
                                      native mobile application in Phase
                                      1.

  Authentication                      Username and password; MFA excluded
                                      from Phase 1 per baseline source.

  Financial scope                     Automated charges, deposits,
                                      refunds, payment gateway and
                                      payroll deductions deferred to
                                      Phase 2.

  Integration scope                   No HRMS integration. Staff records
                                      are entered manually or by CSV.

  Approval status                     Draft baseline; items marked "Grand
                                      Hyatt confirmation required" remain
                                      assumptions.
  -----------------------------------------------------------------------

## How to read this document

-   MUST = mandatory requirement for Phase 1.

-   Recommended default = proposed operating rule to implement unless
    Grand Hyatt changes it during sign-off.

-   Grand Hyatt confirmation required = a business, legal, safety or
    operational policy that must be explicitly approved.

-   Out of scope = not to be implemented in Phase 1 unless formally
    added through change control.

# 1. Executive Summary

Phase 1 will deliver a role-based staff accommodation platform that
manages the lifecycle from staff record creation and eligibility,
through bed allocation and stay management, to checkout, clearance and
bed readiness. It will also provide essential security, maintenance,
contractor, emergency approval and operational reporting workflows.

The platform replaces a shared dashboard exposing all modules to all
users with role-based home screens and scope-based data access. Every
operation is evaluated through one permission model across navigation,
APIs, records, reports and exports.

  -----------------------------------------------------------------------
  **Core lifecycle:** Configure sites and beds → onboard staff → validate
  eligibility → request/allocate → reserve → check in → manage stay →
  mark employment exit or initiate checkout → clearance →
  cleaning/inspection → bed available.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

## 1.1 Confirmed policy selections

  -----------------------------------------------------------------------
  **Topic**                           **Phase 1 rule**
  ----------------------------------- -----------------------------------
  Staff data                          Manual entry and CSV import by
                                      Accommodation Admin; no HRMS sync.

  Duplicate employee IDs              Reject or flag duplicates before
                                      persistence; imports require
                                      preview and error report.

  Employment exit                     Authorised Accommodation Admin
                                      marks staff as "Left organisation";
                                      this triggers exit workflow.

  Login access                        Deactivate account and invalidate
                                      active sessions when employment
                                      status becomes Left.

  Data deletion                       No routine deletion. Records and
                                      audit history are retained; archive
                                      former staff from default active
                                      views.

  Waitlist                            Entry valid for 15 calendar days;
                                      send reminders before expiry, then
                                      close automatically unless renewed
                                      under the approved rule.

  Bed offer                           48-hour acceptance window, separate
                                      from the 15-day waitlist entry
                                      validity.

  Declines                            First decline retains queue
                                      position and skips that offer;
                                      second decline moves the entry to
                                      the back of the eligible queue.

  Emergency check-in                  Provisional stay; 24-hour initial
                                      deadline; reminders every 24 hours;
                                      escalate after two unanswered
                                      reminders; never auto-approve.

  Notifications                       In-app and email only.

  Contractors                         Restricted contractor login,
                                      limited to own vendor/assigned jobs
                                      and authorised visit window.

  Eligibility                         Strict configured gender/grade
                                      rules; exceptions require
                                      authorised approval and an audit
                                      reason.

  Network outage                      Controlled daily
                                      arrivals/departures export and
                                      post-restoration reconciliation.

  Financial automation                Deferred to Phase 2.
  -----------------------------------------------------------------------

# 2. Scope

## 2.1 In scope for Phase 1

-   Organisation and site setup, property hierarchy, room/bed inventory
    and eligibility masters.

-   User accounts, role-based permissions, scope restrictions,
    capability grants and audit trail.

-   Staff directory, manual staff entry, CSV import, employee ID
    deduplication and employment status.

-   Accommodation requests, bed availability, waitlist, reservations,
    bulk allocation and transfers.

-   Front desk arrivals/departures, check-in, provisional emergency
    check-in, checkout and clearance.

-   Key issue/return and key-loss records; asset handover records where
    operationally required.

-   Housekeeping/room readiness, inspections, maintenance requests and
    work orders.

-   Visitor register, security gate workflow, contractor accounts,
    assigned jobs and visit-window validation.

-   Incidents and SOS routing with configurable escalation contacts and
    timers.

-   In-app and email notifications with delivery status, retries and
    duplicate prevention.

-   Operational reports, controlled exports, audit reports and outage
    backup/reconciliation.

-   Responsive desktop/tablet/phone web layouts; phone-first views for
    residents, technicians, contractors and security.

## 2.2 Deferred / out of scope

-   HRMS integration, automatic employee sync, SSO and HRMS
    source-of-truth conflict handling.

-   Native iOS or Android application.

-   MFA in Phase 1 (as specified in the source baseline).

-   Automated accommodation charges, deposits, refunds, payment gateway,
    payroll deductions and financial reconciliation.

-   SMS and WhatsApp notifications; only in-app and email are selected.

-   Permanent deletion as a normal workflow. Routine removal is
    archive/status-based; audit history is immutable.

-   Advanced offline transactions or offline bed allocation. The outage
    export is a reference snapshot only.

-   Any integration or module not listed in the in-scope section unless
    approved through change control.

## 2.3 Phase 1 module inventory

  -----------------------------------------------------------------------
  **Module group**                    **Included capabilities**
  ----------------------------------- -----------------------------------
  Setup & access                      Organisation/settings; site
                                      hierarchy; users/roles/access;
                                      workflow and checklist
                                      configuration.

  People                              Staff directory; manual entry; CSV
                                      import; eligibility/entitlement;
                                      employment exit and clearance.

  Accommodation                       Inventory; allocations;
                                      reservations; waitlist; front desk;
                                      transfers; check-in/out.

  Operations                          Housekeeping; inspections;
                                      maintenance requests/work orders;
                                      keys and basic asset handover.

  Security & access                   Visitors; contractors; gate
                                      check-in/out; incident register;
                                      SOS workflow.

  Resident services                   Own stay/request status;
                                      maintenance request; notifications;
                                      applicable facility/visitor
                                      requests if enabled by client.

  Reporting & audit                   Occupancy/vacancy;
                                      arrivals/departures; pending
                                      approvals; clearance; maintenance;
                                      incident; audit logs and controlled
                                      exports.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Scope guard:** The source document identifies 22 modules in 8 groups.
  This Phase 1 specification selects a practical subset of capabilities
  across those groups; it does not assume every submodule in the original
  module map must ship in the first release.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 3. User Roles and Permissions

Permissions follow Module × Action × Scope. Actions include View,
Create, Edit, Archive, Approve, Override, Export and Configure where
applicable. UI hiding is not a security boundary: APIs must enforce the
same permission checks.

  ----------------------------------------------------------------------------------
  **Role**                **Allowed                  **Restrictions / controls**
                          responsibilities**         
  ----------------------- -------------------------- -------------------------------
  Super Admin             All-site configuration;    Cannot edit/delete audit
                          roles, permission matrix,  records. Last Super Admin
                          scope grants; escalation   cannot be removed or
                          oversight; system masters; downgraded. Sensitive decisions
                          exceptional configuration. remain audited.

  Accommodation Admin     Assigned-site staff        Cannot widen own scope. Cannot
                          master, eligibility,       approve own request/exception.
                          inventory, allocation,     Manual overrides require
                          waitlist, employment exit, permission and reason.
                          transfer,                  
                          checkout/clearance         
                          oversight.                 

  Accommodation Officer / Assigned-site              Cannot alter global eligibility
  Reception               arrivals/departures,       policy or approve own emergency
                          resident lookup with       check-in. Must not mark a bed
                          minimum necessary data,    available before readiness
                          check-in/out execution,    completion.
                          keys, visitor/gate desk    
                          operations, outage exports 
                          if authorised.             

  Staff / Resident        View own profile/stay,     Self scope only. Cannot view
                          submit requests,           other residents\' sensitive
                          accept/decline offers,     records or allocate beds.
                          raise                      
                          maintenance/incident/SOS   
                          requests, view own         
                          status/history.            

  Maintenance Coordinator Assigned-site triage,      Cannot approve own exception.
                          assign work orders, SLA    Financial automation is out of
                          oversight, vendor/job      scope; cost approval capability
                          management and configured  must not create
                          cost approvals if enabled. payment/deduction.

  Technician              View/update assigned work  Assigned jobs only. Cannot
                          orders, record diagnosis,  verify own work where
                          work performed,            independent verification is
                          parts/notes and            required.
                          resolution.                

  Vendor / Contractor     Restricted account; view   Own vendor/assigned jobs only.
                          assigned jobs, site        Access valid only for active
                          instructions and           contract, required documents,
                          authorised visit details;  job assignment and visit
                          update job progress; check window.
                          in/out as permitted.       

  Security                Assigned gate/site visitor Assigned scope only. Cannot
                          and contractor records,    view unnecessary staff data or
                          gate check-in/out,         approve accommodation
                          incident/SOS handling,     exceptions unless separately
                          configured night-key       granted.
                          capability.                

  Read-only Manager       Read-only operational KPIs No
                          and drilldowns within      create/edit/approve/override;
                          assigned scope.            report rows respect scope.

  Auditor                 Read-only audit history    Cannot change operational or
                          within approved audit      audit records. Whether Auditor
                          scope; view privileged     has all-site access requires
                          actions.                   client confirmation.

  Backup / escalation     Human decision on          Must have explicit role/scope;
  approver                escalated provisional      cannot approve own request. The
                          stays or other configured  designated role and coverage
                          approval routes, if        require client confirmation.
                          authorised.                
  ----------------------------------------------------------------------------------

## 3.1 Capability grants

-   Capability grants are scoped, reason-required, optionally
    time-limited, and fully audited.

-   A grant never widens a user\'s assigned site/building/job scope.

-   Grantable capabilities may include HR/staff master, maintenance
    coordinator, key supervisor, inventory supervisor, facility manager,
    building creation, emergency check-in and night keys.

-   Every grant/revoke records who granted it, recipient, scope, expiry,
    reason and timestamp.

-   Pending approvals must be reassigned when an approver is deactivated
    or loses scope.

## 3.2 Separation of duties

-   No user may approve their own request or exception.

-   Emergency check-in initiator and approver must be different users.

-   Work-order resolution and verification should be separate where
    staffing permits; if not, the exception must be visible and
    auditable.

-   Bulk deletes, role/permission changes, workflow publication,
    retention changes and sensitive overrides require maker-checker
    review where enabled by the final governance policy.

# 4. Core Data Hierarchy and Data Model

Physical hierarchy: Site → Building → Floor → Unit → Room → Bed. The bed
is the fundamental allocation unit. Shared spaces are facilities, not
rooms.

  ---------------------------------------------------------------------------------
  **Entity**              **Key fields / relationships**    **Rules**
  ----------------------- --------------------------------- -----------------------
  Site / Building / Floor ID, parent ID, name/code,         Parent must exist;
  / Unit / Room           active/archive status, access     child inherits
                          scope, eligibility defaults,      applicable eligibility
                          capacity/readiness attributes.    unless explicitly
                                                            overridden by
                                                            authorised
                                                            configuration. No
                                                            occupied structure may
                                                            be archived.

  Bed                     ID, room ID, bed code, state,     One active overlapping
                          eligibility, readiness state,     stay/reservation at a
                          blocked reason.                   time. Capacity is
                                                            bed-level, not
                                                            room-level only.

  StaffProfile            Employee ID (unique), name,       No HRMS sync. Employee
                          gender where policy requires,     ID unique after
                          department, designation/grade,    normalisation. Left
                          phone, email/username, joining    status deactivates
                          date, employment status,          login; record retained.
                          emergency contact.                

  UserAccount             Staff/vendor link, username,      Staff login disabled on
                          role, scope, active status,       employment exit.
                          password metadata, last login.    Contractor access also
                                                            requires
                                                            contract/job/window
                                                            checks.

  AccommodationRequest    Resident, site/preferences,       Request is not a
                          dates, request type, eligibility  reservation or active
                          snapshot, status, submitted       stay.
                          timestamp.                        

  WaitlistEntry           Request ID, created_at,           15 calendar day
                          expires_at, priority, queue       validity. Separate
                          sequence, decline_count, status.  offer record and
                                                            48-hour timer.

  BedOffer                Waitlist entry, bed ID,           Temporary hold only;
                          offered_at, delivered_at/status,  expiration releases
                          expires_at, response,             hold. Offer must not
                          response_at.                      conflict with a
                                                            confirmed stay.

  Reservation             Resident, bed, start/end dates,   Unique overlap
                          status, approval reference,       protection; eligibility
                          confirmation timestamp.           revalidated at
                                                            confirmation and
                                                            check-in.

  Stay                    Resident, bed, planned/actual     Stay state and bed
                          dates, status, provisional flag,  state change
                          initiator, approval state.        atomically. Provisional
                                                            stay is not
                                                            automatically approved.

  ApprovalRequest         Subject entity, route step,       No self-approval;
                          assigned approver, due_at,        decisions are
                          reminder count, escalation level, idempotent; audit all
                          decision, reason.                 transitions.

  ClearanceCase           Staff, stay, exit trigger,        Can remain open after
                          checklist items, owner, due date, account deactivation;
                          status.                           admins act on behalf
                                                            with audit attribution.

  KeyRecord /             Key/cabinet/location, linked      Lost/damaged keys are
  KeyTransaction          room/bed/staff, issue/return      not marked returned;
                          timestamps, status, actor.        replacement retires
                                                            prior key and records
                                                            replacement.

  WorkOrder               Issue, location, priority/SLA,    Resolved does not mean
                          assigned technician/vendor,       verified or room ready.
                          status, resolution and verifier.  

  Visitor /               Person, host/job,                 Contractor access valid
  ContractorVisit         documents/contract status, visit  only if all configured
                          window, gate timestamps, pass     prerequisites pass.
                          status.                           

  Incident / SOS          Reporter, location,               Alert, escalation and
                          category/severity, timestamps,    closure are auditable.
                          assigned responders,              
                          acknowledgement/action/closure.   

  Notification            Recipient, channel, template,     In-app/email only in
                          related entity, attempt count,    Phase 1; retries and
                          delivery status, sent/delivered   deduplication required.
                          timestamps.                       

  AuditEvent              Actor, action, entity,            Append-only; no
                          before/after, reason, scope,      ordinary user can
                          timestamp, request/device         edit/delete.
                          metadata where available.         
  ---------------------------------------------------------------------------------

## 4.1 Data integrity and retention

-   Use immutable identifiers internally; employee ID is a unique
    business key, not the database primary key.

-   Store timestamps consistently and display in the configured site
    timezone.

-   Use transactions/locking for reservation, bed allocation, check-in,
    transfer and checkout-related bed changes.

-   Routine removal is archival/status-based. Preserve historical
    relationships and audit events.

-   The source baseline mentions a 30-day archive restore window and
    hard deletion only for Super Admin after the restore window or
    data-erasure request. This conflicts with the new "never delete"
    decision. For Phase 1, disable hard deletion unless Grand
    Hyatt/legal approves a documented exception; retain an audited
    archive/restore process.

  -----------------------------------------------------------------------
  **Grand Hyatt confirmation required:** "Never delete" should be checked
  against applicable privacy, employment and retention requirements. This
  specification implements no routine deletion, but the final retention
  schedule and any legally required erasure exception must be approved by
  the client.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 5. Main User Journeys

## 5.1 Organisation and inventory setup

1.  Super Admin configures organisation settings, sites, role
    permissions, notification templates, approval routes, checklists and
    master data.

2.  Create the hierarchy down to bed level; bulk generation/import must
    preview duplicates and invalid parent relationships.

3.  Set default eligibility rules at site/building/room/bed level and
    define approved override roles.

4.  Validate capacity, active state, blocked/maintenance state, and
    dependencies before activating the structure.

5.  A room/building cannot be archived while occupied, reserved, holding
    active keys/assets or linked to unresolved dependencies.

## 5.2 Staff onboarding

6.  Accommodation Admin enters a staff profile or uploads a CSV
    template.

7.  System validates required fields, employee ID uniqueness,
    email/username uniqueness where applicable, enum values and date
    formats.

8.  CSV import displays a preview with accepted, duplicate, invalid and
    warning rows before commit.

9.  Duplicate employee ID is rejected or flagged; no automatic merge is
    performed.

10. After successful creation, an authorised admin creates/invites a
    user account using a temporary credential or secure password setup
    flow.

11. User must change the temporary password on first login. Account
    activation and staff employment status are separately recorded.

## 5.3 Request, allocation and reservation

12. Resident or authorised officer submits a request with preferred
    site, dates and applicable accommodation requirements.

13. System evaluates staff employment status, configured gender/grade
    eligibility, site scope, bed state and date conflicts.

14. If a matching bed is available, the request follows the configured
    approval path, if any, and the bed is reserved transactionally.

15. If no matching bed exists, create a waitlist entry with a
    15-calendar-day expiry.

16. Before final reservation, revalidate eligibility and availability.
    Request, approval, reservation and active stay are separate
    records/states.

17. Notify the resident and responsible staff in-app and by email. A
    notification failure must not create a duplicate reservation.

## 5.4 Check-in

18. Reception opens the reservation and verifies identity, eligibility,
    arrival date, bed readiness and reservation status.

19. Complete required checklist, key issue and any required asset
    handover.

20. Commit stay activation and bed occupancy in one transaction.

21. If there is no valid reservation, normal check-in is blocked;
    emergency check-in is available only to users with the explicit
    capability.

22. Duplicate check-in, blocked bed, unmet eligibility or conflicting
    reservation must be rejected with an actionable error.

## 5.5 Transfer or bed swap

23. Authorised user selects destination bed and enters the
    reason/effective time.

24. System validates destination eligibility, readiness, capacity and
    availability.

25. Reserve/lock destination before releasing the source bed; record key
    return/reissue and asset handover as applicable.

26. Commit the transfer atomically. If destination allocation fails,
    source stay and bed assignment remain unchanged.

27. Cross-site transfers additionally revalidate site scope and
    cancel/review incompatible future bookings or passes.

## 5.6 Employment exit and clearance

28. Accommodation Admin selects "Mark as left organisation", confirms
    the action and records effective date/reason.

29. System sets employment status to Left, deactivates login,
    invalidates active sessions and blocks new accommodation requests.

30. Create a clearance case, flag current stay and notify the assigned
    clearance officer.

31. Cancel future bookings/passes where applicable; preserve the current
    occupied bed until actual checkout.

32. Complete keys, assets, inspection, belongings and incident/loss
    checklist. Record any outstanding item and owner.

33. Record actual checkout separately from clearance completion. Bed
    moves to Needs Cleaning/Inspection and becomes Available only after
    readiness checks pass.

34. Former employee remains in history and default active lists exclude
    them. Rehire requires authorised reactivation of the existing
    profile after review.

## 5.7 Contractor access

35. Authorised admin creates a contractor account linked to a vendor and
    activates it only for the approved period.

36. Before a visit, validate active vendor/contract, worker documents,
    assigned job, visit window, site and escort requirement.

37. Contractor can see only their vendor\'s assigned jobs and required
    instructions.

38. At the gate, Security verifies identity and prerequisites before
    check-in. Access is denied if any mandatory check fails.

39. At visit end, Security records check-out. Overstay triggers alerts;
    revocation during a visit alerts Security and creates a
    human-managed response.

40. Expired/suspended/terminated vendor or invalid contract must block
    new job/visit access.

# 6. State Transitions

Backend state transitions must be explicit. The API must reject invalid
transitions, duplicate submissions and actions by users outside scope.

  ----------------------------------------------------------------------------------------
  **Entity**              **Allowed normal states**             **Exceptional states /
                                                                transition rules**
  ----------------------- ------------------------------------- --------------------------
  Staff employment        Active → Left                         Rehire: Left → Active only
                                                                through authorised review;
                                                                preserve same employee
                                                                profile and audit history.

  Accommodation request   Draft → Submitted → Pending Approval  Rejected, Cancelled,
                          (if required) → Approved →            Waitlisted. A request is
                          Reserved/Closed                       not itself a reservation.

  Waitlist entry          Active → Offer Pending → Active       Expired at 15 calendar
                          (declined/expired offer) →            days unless renewed under
                          Reserved/Closed                       approved rule; one active
                                                                offer per resident by
                                                                default.

  Bed offer               Created → Delivered/Delivery Pending  48-hour response window.
                          → Accepted/Declined/Expired/Withdrawn Accept only after
                                                                revalidation; expiry
                                                                releases hold and advances
                                                                queue.

  Reservation             Reserved → Checked                    Cancellation and no-show
                          In/Cancelled/No-show/Expired          must release the
                                                                reservation safely and
                                                                audit reason.

  Bed                     Draft → Available → Reserved →        Blocked, Under
                          Occupied → Needs Cleaning → Available Maintenance, Inspection
                                                                Required, Archived. Do not
                                                                mark Available until
                                                                readiness passes.

  Stay                    Reserved → Active → Checkout Due →    Emergency path:
                          Checked Out → Closed                  Provisional → Approved
                                                                Active OR
                                                                Rejected/Resolution
                                                                Pending → human-resolved
                                                                closure.

  Emergency approval      Pending → Reminder 1 → Reminder 2 →   24-hour initial deadline;
                          Escalated → Approved/Rejected         reminders every 24 hours;
                                                                escalate after two
                                                                unanswered reminders.
                                                                Never auto-approve.

  Clearance               Open → In Progress → Pending Items →  May continue after staff
                          Cleared                               login deactivation; cannot
                                                                be closed while mandatory
                                                                checklist items remain
                                                                unresolved.

  Work order              New → Triaged → Assigned → Accepted → On Hold, Reopened,
                          In Progress → Resolved → Verified →   Cancelled. Resolution does
                          Closed                                not automatically make bed
                                                                ready.

  Key transaction         In Cabinet → Issued → Returned        Overdue, Lost, Damaged,
                                                                Retired; replacement
                                                                retires old key and
                                                                creates linked new key.

  Visitor                 Pre-registered → Approved → Checked   Walk-in Pending
                          In → Checked Out                      Confirmation, Denied,
                                                                Overstay.

  Contractor visit        Scheduled → Gate Pass Valid → Checked Denied/Revoked/Overstay;
                          In → Checked Out                      validate contract,
                                                                documents, job and window.

  Incident/SOS            Reported → Acknowledged → Action In   Escalated; closure
                          Progress → Resolved → Closed          requires action/closure
                                                                notes and timestamp.
  ----------------------------------------------------------------------------------------

## 6.1 Atomic transitions

-   Reservation confirmation must lock/check the bed and date range
    within a transaction.

-   Check-in must atomically update the stay and bed; partial success is
    not allowed.

-   Transfer must reserve the destination before releasing the source.
    Failure preserves the original assignment.

-   Checkout ends the stay but does not make the bed Available until
    cleaning/inspection is complete.

-   Every state change records actor, timestamp, previous state, new
    state, reason where required and related approval.

-   Repeated API calls must be idempotent or return the current result
    without duplicate records.

# 7. Waitlist Rules

  -----------------------------------------------------------------------
  **Rule**                            **Requirement**
  ----------------------------------- -----------------------------------
  Entry validity                      15 calendar days from creation;
                                      store created_at and expires_at.

  Reminder                            Send configurable in-app/email
                                      reminders before expiry. Proposed
                                      default: 3 days and 1 day before
                                      expiry; Grand Hyatt confirmation
                                      required.

  Expiry                              At expiry, close the entry
                                      automatically, notify resident and
                                      release any stale offer hold.

  Bed offer                           Separate 48-hour acceptance window.
                                      Start from confirmed delivery; if
                                      delivery cannot be confirmed, retry
                                      and alert staff rather than
                                      silently expiring.

  Queue selection                     Only eligible residents matching
                                      bed/site/date/preferences are
                                      candidates. Proposed order:
                                      approved priority category, then
                                      oldest valid waiting timestamp.

  Declines                            First decline retains position and
                                      skips that bed offer; second
                                      decline during the same entry moves
                                      to the back of the eligible queue.

  No response                         Offer expires after 48 hours, hold
                                      releases and the entry remains
                                      active only if the 15-day entry is
                                      still valid.

  Renewal                             Renewal behaviour and
                                      queue-position preservation require
                                      client confirmation. Recommended
                                      default: renew only after
                                      eligibility revalidation; preserve
                                      original position only if the
                                      resident renews before expiry and
                                      requirements are unchanged.

  Concurrent offers                   One active bed offer per resident
                                      by default; prevent overlapping
                                      holds for the same bed.

  Manual override                     Authorised role only, mandatory
                                      reason, audit record and visibility
                                      in queue history.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Grand Hyatt confirmation required:** Approve queue priority
  categories, whether a first decline has any limit on future offers,
  renewal behaviour, exact reminder timing and what constitutes confirmed
  email delivery.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 8. Emergency Check-in Approval

  -----------------------------------------------------------------------
  **Control**                         **Requirement**
  ----------------------------------- -----------------------------------
  Eligibility                         Only users with explicit Emergency
                                      Check-in capability may initiate;
                                      capture reason and required
                                      supporting details.

  Initial deadline                    24 hours from provisional stay
                                      creation.

  Reminder cadence                    Every 24 hours while pending;
                                      record reminder count, recipient
                                      and delivery status.

  Escalation                          After two unanswered reminders,
                                      escalate to the designated Super
                                      Admin or authorised backup
                                      approver.

  Status                              Stay remains Provisional until an
                                      authorised human decision.
                                      Dashboard must show age, due time,
                                      approver and escalation level.

  Approval                            Approver must differ from
                                      initiator. Revalidate bed,
                                      eligibility and required policy
                                      checks; transition to approved
                                      active stay.

  Rejection                           Require reason; create a
                                      human-managed
                                      resolution/relocation/checkout task
                                      with a deadline. Never
                                      automatically remove the resident.

  Approver unavailable                Reassign to authorised backup and
                                      audit reassignment. Do not silently
                                      stop reminders.

  Maximum duration                    Configure a maximum provisional
                                      duration as a critical escalation
                                      threshold only; it is not an
                                      automatic checkout deadline.

  Audit                               Record initiator, reason, approver,
                                      reminders, failures, escalation,
                                      decision and all timestamps.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Grand Hyatt confirmation required:** Name the primary and backup
  approval roles, escalation contact, on-duty coverage, maximum
  provisional duration and rejection-resolution SLA.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 9. Employment Exit, Access and Retention

-   Only an authorised Accommodation Admin/HR capability holder may mark
    a staff profile as Left.

-   The action requires confirmation and captures effective date, actor
    and reason. Bulk exit must include a preview and confirmation step.

-   Login deactivation and active-session invalidation must occur
    immediately after the employment-status change is committed.

-   Existing stay, clearance, keys, assets, work orders and audit
    records remain accessible to authorised staff; resident access is
    disabled.

-   Future reservations and visitor/contractor permissions linked to the
    employee are cancelled or reviewed according to configured policy.

-   Do not automatically release occupied beds, mark checkout complete
    or close clearance.

-   Former staff are archived from default active lists but remain
    searchable by authorised users for historical operations.

-   Rehire uses the existing staff record after duplicate and status
    review; never create a second active profile for the same employee
    ID.

## 9.1 Data retention governance

No routine deletion is implemented in Phase 1. Retention period, legal
hold, data subject requests and any legally required erasure exception
need client legal/HR approval. Audit history must remain append-only and
ordinary administrators cannot edit or delete it.

# 10. Notifications and Network Outage

## 10.1 In-app and email notifications

-   Notification events include request submission, bed offer,
    offer/entry expiry reminders, approval due/overdue, SOS, maintenance
    assignment, contractor access changes and clearance due/overdue.

-   Store queued/sent/delivered/failed status where the email provider
    supports delivery confirmation; distinguish accepted-by-provider
    from actual inbox receipt.

-   Retry transient failures with bounded backoff; avoid duplicate
    user-visible notifications for the same event and attempt.

-   If a critical alert cannot be delivered after retries, surface it in
    the admin dashboard and trigger the configured in-platform
    escalation.

-   Notifications are informational; approval, allocation or check-in
    state changes only after a valid authenticated action.

## 10.2 Outage export and reconciliation

41. Authorised Reception user exports a date-stamped arrivals/departures
    list for a selected site/shift.

42. Export includes minimum necessary fields: staff identifier, display
    name, expected event, scheduled date/time, bed/room reference and
    operational status; no unnecessary emergency-contact data.

43. Export is watermarked with generation time, site, user and "snapshot
    --- not live availability" notice.

44. Access/download is permission-controlled and logged. Client must
    define secure storage and disposal time for local copies.

45. During outage, staff use the approved paper/offline log for actions.
    New bed allocation is not guaranteed safe from a stale export.

46. After service restoration, authorised staff reconcile each offline
    event against current records, resolve conflicts and record the
    reconciler, timestamp and outcome.

47. Do not bulk-import offline actions without duplicate, state and
    capacity validation.

  -----------------------------------------------------------------------
  **Grand Hyatt confirmation required:** Confirm export fields, allowed
  storage medium, disposal interval, offline log template, outage owner
  and the approved policy for urgent arrivals when no live availability
  can be verified.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 11. Eligibility, Capacity and Inventory Validation

  -----------------------------------------------------------------------
  **Validation**                      **Expected result**
  ----------------------------------- -----------------------------------
  Employee status                     Left staff cannot submit new
                                      requests or check in; authorised
                                      staff may complete existing
                                      checkout/clearance.

  Gender eligibility                  Strictly enforce configured
                                      compatibility; missing required
                                      data blocks allocation pending
                                      correction/review.

  Grade/entitlement                   Match the configured
                                      grade-to-accommodation matrix where
                                      applicable; no silent fallback to a
                                      different entitlement.

  Bed state                           Blocked, archived,
                                      under-maintenance, occupied or
                                      not-ready beds cannot be allocated.

  Date overlap                        Prevent overlapping active
                                      reservations/stays for the same bed
                                      and conflicting resident allocation
                                      where policy disallows it.

  Capacity                            Never exceed physical bed capacity.
                                      Reducing capacity below
                                      occupancy/reservations is blocked
                                      or requires an explicit remediation
                                      plan.

  Hierarchy blocking                  Blocking a building/room prevents
                                      new allocations to all descendants;
                                      existing occupants are flagged for
                                      human action.

  Archive dependencies                Cannot archive occupied/reserved
                                      structure or one with unresolved
                                      key/asset/work-order dependencies.

  Emergency override                  Requires explicit capability,
                                      reason, audit and human approval;
                                      cannot bypass physical
                                      safety/capacity or
                                      double-allocation invariants.

  Bulk operations                     Preview impacted rows and errors;
                                      require confirmation; partial
                                      failures are reported and
                                      retry-safe.
  -----------------------------------------------------------------------

# 12. Maintenance, Housekeeping and Bed Readiness

48. Resident or staff submits issue with category, location, description
    and optional attachment if enabled.

49. Maintenance Coordinator triages priority/SLA and assigns a
    technician or authorised contractor.

50. Technician accepts, updates progress, records work and marks
    Resolved.

51. Independent verifier checks the work and marks Verified; reopening
    returns it to In Progress or a configured status.

52. If the issue makes a bed/room unsafe or unavailable, mark it
    Blocked/Under Maintenance and prevent new allocation.

53. After checkout, bed enters Needs Cleaning/Inspection. Cleaning
    completion alone does not make it Available if inspection is
    required.

54. Only authorised role may mark readiness complete; all checklist
    results and exceptions are recorded.

# 13. Visitor, Contractor, Incident and SOS

## 13.1 Visitor flow

Pre-register → approve if required → identity check → gate check-in →
gate check-out. Walk-ins follow a pending-confirmation or denial path.
Overstay is flagged for Security. Exact visitor hours, resident
confirmation and overnight rules require client approval.

## 13.2 Contractor flow

Create restricted contractor account → validate vendor/contract/worker
documents/job/visit window → issue gate pass → security verifies → check
in → perform assigned job → check out. Any failed mandatory prerequisite
denies access and records the reason.

## 13.3 SOS flow

55. SOS is created with reporter, site/location, timestamp, category and
    available contact details.

56. Notify the designated on-duty Security team and configured
    accommodation emergency contact through in-app/email.

57. Track acknowledgement and response; if not acknowledged within the
    configured interval, escalate to Security Supervisor and designated
    accommodation authority.

58. Record action taken, handoff, resolution and closure note.
    Reopening/escalation remains possible under permission rules.

59. If network connectivity is unavailable, the app cannot guarantee
    delivery; the site must maintain a client-approved physical/phone
    emergency fallback.

  -----------------------------------------------------------------------
  **Grand Hyatt confirmation required:** Confirm SOS recipients,
  response/acknowledgement SLA, escalation chain, location data, on-duty
  roster, emergency fallback and closure authority. Proposed initial
  acknowledgement threshold: 5 minutes, subject to client approval.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# 14. Reporting and Audit

  ---------------------------------------------------------------------------------------
  **Report/dashboard**                **Minimum data**
  ----------------------------------- ---------------------------------------------------
  Occupancy and vacancy               Site/building/room/bed counts by Available,
                                      Reserved, Occupied, Blocked, Maintenance and Needs
                                      Cleaning; timestamp/as-of indicator.

  Arrivals/departures                 Expected and actual arrival/departure, no-show,
                                      overdue checkout and responsible desk.

  Waitlist                            Active entries, age, expiry, queue priority, active
                                      offers, offer deadlines, declines and expired
                                      entries.

  Approvals                           Pending, overdue, escalated, approver, age and next
                                      action; include provisional emergency stays.

  Clearance                           Open cases, outstanding keys/assets/checklist
                                      items, overdue items and assigned owner.

  Maintenance/readiness               Open work orders by priority/SLA,
                                      resolved-not-verified items, blocked beds and
                                      cleaning queue.

  Security/SOS                        Open incidents, acknowledgement time, escalation
                                      level, action and closure status.

  Audit                               Who/when/action/entity/before-after/reason/scope;
                                      privileged actions and overrides.
  ---------------------------------------------------------------------------------------

-   Reports must enforce the same permission and scope rules as the
    operational UI.

-   Every report must show an "as of" timestamp and distinguish live
    data from exported snapshots.

-   Exports are permission-controlled, watermarked and audited.

-   KPI definitions and targets are configurable; numerical SLA targets
    not supplied by the client must not be hardcoded.

# 15. Non-Functional Requirements

  -----------------------------------------------------------------------
  **ID**                              **Requirement**
  ----------------------------------- -----------------------------------
  NFR-01                              Responsive web UI works on current
                                      supported desktop, tablet and phone
                                      browsers; phone-first layouts for
                                      residents, technicians, contractors
                                      and Security.

  NFR-02                              All access control is enforced
                                      server-side for every API, report
                                      and export; UI hiding is
                                      supplementary only.

  NFR-03                              Sensitive actions and state
                                      transitions are audit logged; audit
                                      records are append-only.

  NFR-04                              Allocation, reservation, check-in,
                                      transfer and checkout operations
                                      are transaction-safe and
                                      concurrency-safe.

  NFR-05                              Notifications use retry,
                                      deduplication and observable
                                      delivery status.

  NFR-06                              CSV import/export validates
                                      encoding, headers, field lengths,
                                      date formats and malicious formula
                                      content; export is logged.

  NFR-07                              Session expiry and password policy
                                      are configurable; admin sessions
                                      should be stricter than resident
                                      sessions. Exact values require
                                      client approval.

  NFR-08                              Personal information is shown only
                                      to roles requiring it; exports use
                                      minimum necessary data.

  NFR-09                              System errors are actionable
                                      without exposing secrets or
                                      sensitive internal details.

  NFR-10                              Backups, recovery objectives,
                                      hosting, monitoring, performance
                                      targets and supported browsers must
                                      be agreed before production
                                      release.

  NFR-11                              System stores site-local
                                      dates/times consistently and
                                      handles daylight-saving changes if
                                      relevant to deployment location.

  NFR-12                              All bulk actions support preview,
                                      confirmation and a traceable result
                                      summary.
  -----------------------------------------------------------------------

# 16. Acceptance Test Matrix

  -------------------------------------------------------------------------------
  **Test ID**       **Scenario**      **Test action**       **Expected result**
  ----------------- ----------------- --------------------- ---------------------
  AT-001            Role-based access Resident attempts to  Request denied; no
                                      view another          data disclosed; event
                                      resident\'s profile   logged where
                                      via UI and direct     appropriate.
                                      API.                  

  AT-002            Scope enforcement Officer assigned to   API returns
                                      Site A requests Site  denied/not found
                                      B data by changing    without leaking
                                      URL/API parameters.   records.

  AT-003            Duplicate staff   Create a staff record Save blocked with
                    ID                using an existing     clear duplicate
                                      employee ID.          message.

  AT-004            CSV preview       Import CSV containing Preview separates row
                                      valid, duplicate and  outcomes; no records
                                      malformed rows.       committed before
                                                            confirmation.

  AT-005            CSV partial error Confirm import with   Valid rows save once;
                                      mixed valid/invalid   rejected rows
                                      rows under approved   downloadable with
                                      partial-import        reasons; summary is
                                      policy.               accurate.

  AT-006            Gender            Allocate staff to an  Allocation blocked;
                    restriction       incompatible          no reservation
                                      restricted bed.       created.

  AT-007            Grade entitlement Allocate a staff      Blocked unless
                                      member to a bed       authorised exception
                                      outside configured    workflow completes.
                                      grade entitlement.    

  AT-008            Concurrent        Two users reserve the At most one succeeds;
                    allocation        same bed/date range   losing request
                                      at the same time.     receives actionable
                                                            conflict.

  AT-009            Waitlist creation No matching bed       Entry created with
                                      exists for eligible   correct
                                      request.              created/expiry dates
                                                            and queue position.

  AT-010            Waitlist expiry   Advance clock/test    Entry closes,
                                      expiry past 15 days   reminder history
                                      without renewal.      remains, resident is
                                                            notified and stale
                                                            offer hold releases.

  AT-011            Bed offer timer   Offer is delivered    Offer expires, hold
                                      and no response       releases, queue is
                                      occurs for 48 hours.  updated and next
                                                            eligible resident may
                                                            be offered.

  AT-012            First decline     Resident declines     Offer hold releases;
                                      first offer.          entry stays active
                                                            and queue position is
                                                            retained.

  AT-013            Second decline    Resident declines     Entry moves to back
                                      second offer within   of eligible queue;
                                      same entry.           audit records
                                                            prior/new sequence.

  AT-014            Email failure     Email delivery fails  Retry occurs; failure
                                      for an offer or       is visible; state is
                                      critical alert.       not falsely treated
                                                            as
                                                            delivered/approved.

  AT-015            Emergency         Provisional stay      Reminder is issued;
                    approval deadline remains pending       status remains
                                      beyond 24 hours.      Provisional.

  AT-016            Emergency         Two 24-hour reminders Case escalates to
                    escalation        remain unanswered.    configured authorised
                                                            backup/Super Admin;
                                                            no auto-approval.

  AT-017            Self-approval     Emergency check-in    Decision blocked and
                                      initiator attempts to audited.
                                      approve own stay.     

  AT-018            Emergency         Approver rejects a    Reason mandatory;
                    rejection         provisional stay.     resolution task
                                                            created; resident is
                                                            not automatically
                                                            moved or checked out.

  AT-019            Employment exit   Admin marks an        Login/session
                                      occupied resident as  revoked; clearance
                                      Left.                 case created; stay
                                                            remains occupied
                                                            until actual
                                                            checkout.

  AT-020            Clearance after   Former employee has   Authorised admin
                    deactivation      an outstanding        completes on their
                                      key/asset.            behalf; actor and
                                                            checklist history
                                                            retained.

  AT-021            Checkout          Checkout is complete  Bed remains Needs
                    readiness         but                   Cleaning/Inspection
                                      cleaning/inspection   and cannot be
                                      is not.               allocated.

  AT-022            Transfer failure  Destination bed       Transfer fails
                                      becomes unavailable   safely; source
                                      during transfer.      stay/bed assignment
                                                            remains intact.

  AT-023            Contractor        Contractor attempts   Access denied; reason
                    prerequisites     access with expired   logged; Security sees
                                      contract or outside   denial.
                                      visit window.         

  AT-024            Contractor scope  Contractor tries to   Access denied by API.
                                      view another          
                                      vendor\'s job.        

  AT-025            SOS escalation    SOS remains           Escalation
                                      unacknowledged past   notification is
                                      configured threshold. generated and event
                                                            remains open until
                                                            human resolution.

  AT-026            Outage export     Reception exports     Export includes
                                      arrivals/departures   watermark/as-of
                                      for assigned site.    timestamp, minimum
                                                            necessary fields and
                                                            audit record.

  AT-027            Outage            Offline arrival is    Conflict flagged for
                    reconciliation    reconciled after      authorised review; no
                                      restoration when live duplicate stay or
                                      data has changed.     double allocation.

  AT-028            Audit             User attempts to      Operation denied.
                    immutability      edit/delete audit     
                                      record.               

  AT-029            Archive           Admin attempts to     Operation blocked
                    dependencies      archive an occupied   with dependencies
                                      room/building.        listed.

  AT-030            Notification      Same event is retried No duplicate
                    idempotency       after timeout.        reservation, approval
                                                            or uncontrolled
                                                            duplicate
                                                            notification.

  AT-031            Report scope      Read-only manager     Out-of-scope data
                                      exports report        excluded and export
                                      outside assigned      logged.
                                      scope.                

  AT-032            Rehire            Authorised admin      Existing profile is
                                      reactivates a former  reused after review;
                                      employee with the     no duplicate active
                                      same employee ID.     profile is created.

  AT-033            Escalation        Standard request,     Refused before the
                    backup (P-01)     transfer or           backup level with
                                      extension reaches     reason and owner;
                                      the backup level of   allowed from it;
                                      the approval clock;   initiator and subject
                                      a Policy Approver     never; audited. Inbox
                                      decides it. Before    and API agree.
                                      that level the same
                                      person tries.

  AT-034            Password re-      Mark as Left,         Nothing changes; clear
                    confirmation      waiver, rehire,       field error; attempts
                    (D-03, P-02)      emergency             throttled and counted;
                                      initiation, role      correct password
                                      change or queue       proceeds; the list of
                                      override with a       actions is
                                      missing or wrong      configurable and
                                      password; repeated    audited.
                                      wrong attempts.

  AT-035            Key control       Mark a key lost or    Never marked returned;
                    (D-73, P-03 to    damaged, try to       replacement retires
                    P-05)             return it; replace    the old key and links
                                      it; issue out of      the new; out-of-hours
                                      hours; resident       flagged (refused only
                                      reports own key       if enforced); evidence
                                      lost.                 and resident report
                                                            only if enabled; every
                                                            movement in the event
                                                            log and audit.

  AT-036            Cross-site        Transfer to another   Refused with owner and
                    transfer          site whose room rule  next action; allowed
                    eligibility       the person fails;     after a recorded
                    (D-104, P-09,     with and without a    exception; both sites
                    P-10)             Policy Approver       approve; the source
                                      exception; raised by  stays intact on
                                      Reception.            failure; Reception
                                                            only if enabled.

  AT-037            Bed readiness     Offer or check in to  Not offered inside the
                    (AT-021, P-13,    a bed that is not     lead time, not checked
                    P-14)             ready; bed in         into; only a passed
                                      Inspection required   final inspection by
                                      with no cleaning      someone other than the
                                      record; failed        cleaner makes it
                                      inspection.           Available; manual task
                                                            path audited.

  AT-038            Separation of     Every approve,        Refused with the
                    duties matrix     decide, allocate,     independent-approver
                    (D-26)            process, inspect,     reason in every
                                      clean, verify, waive  workflow; audited
                                      and emergency action  where specified; no
                                      attempted by the      path lets anyone act
                                      person it concerns    on their own record.
                                      or by the person who
                                      raised it.

  AT-039            Audit             Run each mutating     Each success writes
                    completeness      workflow once, and a  one audit event with
                    (D-27, AT-028)    refused one.          actor, role, entity,
                                                            site, reason and
                                                            before and after in
                                                            the same transaction;
                                                            a refused command
                                                            leaves none; no API
                                                            edits or deletes an
                                                            audit row.

  AT-040            Proposed-policy   Read and change each  Each is listed as
                    switches          proposed-policy       pending client sign-
                                      setting.              off with its default;
                                                            every change is a new
                                                            audited version; the
                                                            shipped default
                                                            reproduces the
                                                            previous behaviour
                                                            unless the policy is
                                                            documented already.
  -------------------------------------------------------------------------------

# 17. Assumptions and Grand Hyatt Sign-off Register

  -----------------------------------------------------------------------------------
  **ID**            **Decision /        **Recommended default**    **Owner / status**
                    assumption**                                   
  ----------------- ------------------- -------------------------- ------------------
  GH-01             Super Admin         Client IT owns at least    Grand Hyatt
                    ownership           two Super Admin accounts;  confirmation
                                        vendor support is          required
                                        separately scoped and      
                                        time-limited.              

  GH-02             Site/building       Client provides site list, Client to provide
                    structure           hierarchy, room/bed        
                                        inventory and codes before 
                                        migration/import.          

  GH-03             Eligibility matrix  Client provides            Grand Hyatt
                                        gender/grade/designation   confirmation
                                        rules, eligible room types required
                                        and authorised exception   
                                        approvers.                 

  GH-04             Waitlist priority   Approved priority category Grand Hyatt
                                        first, then oldest valid   confirmation
                                        waiting timestamp; define  required
                                        categories and             
                                        tie-breaker.               

  GH-05             Waitlist renewal    Renewal only after         Grand Hyatt
                                        revalidation; position     confirmation
                                        preservation depends on    required
                                        renewal timing and         
                                        unchanged preferences.     

  GH-06             Waitlist reminder   Proposed reminders 3 days  Grand Hyatt
                    timing              and 1 day before 15-day    confirmation
                                        expiry.                    required

  GH-07             Emergency           Name primary/backup        Grand Hyatt
                    escalation          approvers, coverage,       confirmation
                                        maximum provisional        required
                                        duration and               
                                        rejection-resolution SLA.  

  GH-08             SOS routing         Name recipients,           Grand Hyatt
                                        acknowledgement SLA,       confirmation
                                        escalation contacts and    required
                                        physical/phone fallback.   

  GH-09             Contractor access   Client supplies vendor     Grand Hyatt
                                        contracts, mandatory       confirmation
                                        documents, job and         required
                                        visit-window rules, escort 
                                        rules and account sponsor. 

  GH-10             Visitor policy      Confirm visitor hours,     Grand Hyatt
                                        resident confirmation,     confirmation
                                        overnight visits,          required
                                        restricted areas and gate  
                                        pass rules.                

  GH-11             Retention/privacy   Client legal/HR confirms   Grand Hyatt
                                        retention schedule,        confirmation
                                        former-employee data       required
                                        policy and any legally     
                                        required erasure           
                                        exceptions.                

  GH-12             Outage procedure    Approve export fields,     Grand Hyatt
                                        secure storage, disposal   confirmation
                                        interval, offline log and  required
                                        reconciliation owner.      

  GH-13             Email provider      Provide sender domain,     Client/technical
                                        SMTP/provider, templates,  setup
                                        retry limits and delivery  
                                        telemetry availability.    

  GH-14             Security policy     Confirm password/session   Grand Hyatt
                                        policy, account recovery,  confirmation
                                        support access and         required
                                        incident response.         

  GH-15             Data migration      Confirm whether existing   Grand Hyatt
                                        records require import and confirmation
                                        provide approved source    required
                                        files/mapping.             

  GH-16             SLA/KPI targets     Confirm maintenance        Grand Hyatt
                                        priorities,                confirmation
                                        response/resolution        required
                                        targets, occupancy KPI     
                                        definitions and report     
                                        recipients.                

  GH-17             Facility booking    Confirm whether facility   Grand Hyatt
                                        reservations are in Phase  confirmation
                                        1 and, if so, capacity,    required
                                        approval, fees/deposits    
                                        and no-show rules.         

  GH-18             Housekeeping        Confirm owner of cleaning  Grand Hyatt
                                        tasks, inspection          confirmation
                                        checklist, same-day        required
                                        allocation policy and      
                                        required verifier.         

  GH-19             Emergency maximum   Set maximum provisional    Grand Hyatt
                    duration            duration as critical       confirmation
                                        escalation threshold, not  required
                                        auto-checkout.             

  GH-20             Backup authority    Confirm what happens if    Grand Hyatt
                                        the primary approver and   confirmation
                                        Super Admin are            required
                                        unavailable.               
  P-01              Backup approval at  Policy Approver or Backup  PROPOSED, pending
                    the escalation      Approver decides a         client sign-off
                    level (S-14)        standard request, transfer
                                        or extension once it
                                        reaches the backup level
                                        (APPROVALS.md). Ships ON.

  P-02              Password re-        D-03 actions enforced at   PROPOSED, pending
                    confirmation list   the API (emergency         client sign-off
                    (S-18)              initiation, role change,
                                        queue override); emergency
                                        decisions and capability
                                        grants optional. Ships
                                        with the D-03 set ON.

  P-03              Key desk office     Hours 08:00 to 20:00 per   PROPOSED, pending
                    hours (S-19)        site; out-of-hours always  client sign-off
                                        flagged; enforcement
                                        (Reception refused out of
                                        hours) ships OFF.

  P-04              Evidence for a      At least one file          PROPOSED, pending
                    damaged key (S-19)  required. Ships OFF.       client sign-off

  P-05              Resident reports    Resident may report a held PROPOSED, pending
                    own key lost        key lost; never mark       client sign-off
                    (S-19)              returned. Ships OFF.

  P-06              Waiver writes off   A waived lost key is       PROPOSED, pending
                    a lost key (S-20)   retired, history kept, so  client sign-off
                                        the stay can close. Ships
                                        ON (built in Stage 3).

  P-07              Clearance items     Reception completes        PROPOSED, pending
                    only by owner       Reception items, AA or SA  client sign-off
                    (S-20)              the AA items, MC the
                                        Maintenance items. Ships
                                        OFF.

  P-08              Mark as Left with   Only a Super Admin marks   PROPOSED, pending
                    no accommodation    Left a person who never    client sign-off
                    site (S-20)         had a stay, reservation or
                                        request. Ships OFF.

  P-09              Reception raises    Reception may raise a      PROPOSED, pending
                    transfers (S-21)    transfer or swap on behalf client sign-off
                                        of a resident at their
                                        site; never approve. Ships
                                        OFF.

  P-10              Exception for a     Policy Approver may grant  PROPOSED, pending
                    transfer            a recorded gender or grade client sign-off
                    destination (S-21)  exception for one transfer
                                        (D-25). Ships ON.

  P-11              Cross-site swap     Name and site of an active PROPOSED, pending
                    partner by          stay shown to the          client sign-off
                    employee ID (S-21)  requesting admin. Ships
                                        OFF.

  P-12              Future bookings     cancel (current) or        PROPOSED, pending
                    after a cross-site  review. Ships cancel.      client sign-off
                    move (S-21)

  P-13              Offers on beds      Not offered for a start    PROPOSED, pending
                    that are not ready  date inside the lead time  client sign-off
                    (S-22)              (1 day); aligns with
                                        AT-021 and SPEC-AMENDMENTS
                                        C-6. Ships ON.

  P-14              Manual cleaning     Reception or Super Admin   PROPOSED, pending
                    task for a bed      opens a task, with a       client sign-off
                    with no record      reason, for a bed in Needs
                    (S-22)              cleaning or Inspection
                                        required that has none
                                        (migrated or seeded).
                                        Ships ON.

  -----------------------------------------------------------------------------------

# 18. Implementation Sequence and Release Gates

  -----------------------------------------------------------------------
  **Stage**               **Build items**         **Exit gate**
  ----------------------- ----------------------- -----------------------
  Stage 1 --- Foundation  Auth, roles/scopes,     Permission tests pass;
                          audit, masters, site    hierarchy and duplicate
                          hierarchy, bed          checks work.
                          inventory, staff        
                          profile and CSV import. 

  Stage 2 ---             Eligibility, requests,  No double allocation;
  Accommodation core      allocation,             valid state transitions
                          reservation,            and waitlist timers
                          waitlist/offers,        pass.
                          check-in, stay,         
                          transfer and checkout.  

  Stage 3 --- Clearance   Employment exit,        Exit never falsely
  and readiness           account deactivation,   frees an
                          clearance checklist,    occupied/not-ready bed.
                          keys/assets,            
                          cleaning/inspection and 
                          bed release.            

  Stage 4 --- Operations  Maintenance, contractor Scope, visit-window and
  and security            login, visitor/gate     escalation tests pass.
                          workflow, incidents and 
                          SOS escalation.         

  Stage 5 ---             In-app/email, retries,  Report totals
  Notifications and       dashboard queues,       reconcile; export
  reporting               reports, exports and    controls and audit
                          outage reconciliation.  pass.

  Stage 6 --- UAT and     Role-based end-to-end   All critical acceptance
  launch                  tests, training, data   tests pass; no open
                          load, support runbook,  severity-1/critical
                          backup/recovery and     defects.
                          client sign-off.        
  -----------------------------------------------------------------------

## 18.1 Release blockers

-   Unapproved eligibility matrix or no nominated owner for eligibility
    exceptions.

-   No designated emergency approval/escalation chain.

-   No agreed SOS recipient and fallback procedure.

-   Unresolved retention/privacy policy for former staff records.

-   No approved inventory/bed capacity baseline.

-   Critical double-allocation, access-control or checkout/readiness
    test failures.

-   No operational owner for outage reconciliation and contractor
    access.

# 19. Definition of Done

-   Every Phase 1 screen, action and API has an owner role, scope,
    validation and failure path.

-   Every lifecycle entity has documented allowed transitions and
    prohibited transitions.

-   No allocation or stay transition can bypass eligibility, capacity or
    permission checks.

-   Critical workflows are auditable from initiation through resolution.

-   Notifications are observable and cannot change business state by
    themselves.

-   CSV imports and exports have preview/validation, access control and
    audit history.

-   Role-based dashboards show only authorised modules, records, actions
    and reports.

-   All critical acceptance tests pass in the client-approved test
    environment.

-   Grand Hyatt has signed off the decision register and operating
    procedures.

-   Production support, backup/recovery, admin ownership and incident
    escalation are documented.

# Appendix A --- Minimum Staff CSV Template

Required fields depend on the approved eligibility policy. Proposed
template:

  -----------------------------------------------------------------------
  **Field**                           **Requirement / validation**
  ----------------------------------- -----------------------------------
  employee_id                         Required; unique after trimming and
                                      case/format normalisation.

  full_name                           Required.

  gender                              Required when the configured
                                      accommodation eligibility policy
                                      uses it; use approved values.

  department                          Required if used in reporting or
                                      eligibility.

  designation_or_grade                Required if accommodation
                                      entitlement depends on it.

  phone                               Validate format; confirm whether
                                      mandatory.

  email_or_username                   At least one approved login
                                      identifier; unique if used as
                                      username.

  joining_date                        Valid date; cannot be malformed.

  employment_status                   Active or Left; new staff import
                                      should default to Active only if
                                      approved.

  emergency_contact_name              Confirm whether required.

  emergency_contact_phone             Confirm whether required and how it
                                      is protected.
  -----------------------------------------------------------------------

# Appendix B --- Core API / Service Invariants

-   A bed cannot have two overlapping active reservations or stays.

-   An occupied bed cannot be archived, blocked without a controlled
    remediation flow, or released by account deactivation alone.

-   A stay cannot be active without a valid bed assignment, except a
    provisional emergency stay created through the authorised emergency
    flow.

-   A Provisional Stay cannot become approved without a distinct
    authorised approver.

-   A contractor session cannot access a job outside vendor and
    assignment scope or outside the valid access window.

-   A former employee cannot authenticate or submit new resident
    requests.

-   No routine workflow deletes staff history or audit events.

-   A notification failure never implies approval or reservation failure
    unless the underlying business transaction itself failed.

-   Every override is permission-checked, reason-required, and logged.

-   Every export is scope-filtered and audited.

# Appendix C --- Amendments of 14 Oct 2026 (hardening round)

This appendix records what changed in the behaviour described above since v1.0, so that the text and the acceptance tests agree with the
build. `DECISIONS.md` remains the source of truth where the two differ. **Items marked PROPOSED are not approved policy**: each is a
recommendation implemented behind a setting (System configuration, shown as "Proposed, pending client sign-off") and listed in the
sign-off register (section 17, P-01 to P-14). Where a proposal ships OFF, the system behaves as before until Grand Hyatt signs it off.

| Section | Change | Status |
|---|---|---|
| 5.5 (transfer or swap), 6 | Transfers and swaps may cross sites. The Accommodation Admin of the source site and the one of the destination site both approve; eligibility and readiness are revalidated at the destination; execution is one atomic operation and a failure leaves the resident in place. | DECIDED (D-104; two approvals DEFAULT) |
| 5.5 | Reception may raise a transfer on a resident's behalf (never approve). | PROPOSED P-09, OFF |
| 5.5 | A Policy Approver may grant a recorded exception for one transfer destination that fails the gender or grade rule. | PROPOSED P-10, ON |
| 5.5 | An admin may name a swap partner at another site by employee ID (name and site only). | PROPOSED P-11, OFF |
| 5.5 step 27 | Stray future bookings after a cross-site move are cancelled, or left for review. | PROPOSED P-12, cancel |
| 5.3, 8, 21 (approvals) | A Policy Approver or Backup Approver may decide a standard request, transfer or extension once it reaches the backup level of the approval clock; before that, only the Accommodation Admin. | PROPOSED P-01, ON (APPROVALS.md) |
| 10 (security) | Password re-confirmation (D-03) is enforced for Mark as Left, bulk exit, clearance waiver and rehire in the command, and at the API for emergency initiation, role changes and queue overrides. Emergency decisions and capability grants can be added to the list. | D-03 DEFAULT; extras PROPOSED P-02 |
| 5.6 (clearance) | A waiver of a lost key retires the key record so the stay can close; history is kept. | PROPOSED P-06, ON |
| 5.6 | Clearance items may be restricted to their owner. | PROPOSED P-07, OFF |
| 5.6 | A person who never had a stay, reservation or request at any site can be marked Left only by a Super Admin. | PROPOSED P-08, OFF |
| 11 (keys) | Key desk office hours (08:00 to 20:00 per site), flagged on every movement, optionally enforced; evidence for a damaged key; a resident may report their own key lost. A lost or damaged key is never marked returned (D-73, DECIDED). | PROPOSED P-03, P-04, P-05, OFF |
| 12 (readiness) | A bed that is not ready cannot be checked into or offered for a start date inside the lead time (1 day), and becomes Available only through a passed final inspection by someone other than the cleaner (AT-021, DECIDED). A bed with no cleaning record can be given a task by hand. | P-13, P-14 PROPOSED, ON (AT-021, SPEC-AMENDMENTS C-6) |
| 16 | Acceptance tests AT-033 to AT-040 added. | New |


# Approval

This specification is ready for technical estimation and implementation
planning, subject to the client confirmation register above. Business
rules marked as assumptions should not be treated as approved policy
until Grand Hyatt signs off.

  -----------------------------------------------------------------------
  **Approval role** **Name**          **Signature /     **Date**
                                      approval          
                                      reference**       
  ----------------- ----------------- ----------------- -----------------
  Grand Hyatt                                           
  business owner                                        

  Grand Hyatt IT /                                      
  Security                                              

  Accommodation                                         
  operations owner                                      

  Adpedia delivery                                      
  lead                                                  
  -----------------------------------------------------------------------
