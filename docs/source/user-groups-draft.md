1. User groups for Phase 1

1. Super Admin
Full system control
- Manage all sites, buildings, rooms, beds and users.
- Configure roles, permissions, workflows and system settings.
- Access all reports, audit logs and exception records.
- Approve authorised overrides and manage emergency escalations.
- Perform exceptional administrative actions, subject to safeguards.
  Restriction: the last active Super Admin cannot be removed or downgraded.




2. Accommodation Admin
Operational administration
- Create and update staff/resident profiles manually or through CSV.
- Manage employee eligibility, gender/grade restrictions and authorised exceptions.
- Manage site hierarchy, rooms, individual beds, capacity and availability.
- Process accommodation requests, reservations, check-ins and check-outs.
- Manage waitlists, charges-free Phase 1 accommodation records, and clearance tasks.
- Mark employees as having left the organisation and deactivate their login.
  Scope: assigned sites/buildings unless explicitly granted wider access.




3. Reception / Accommodation Officer
- View current occupancy, available beds and arrivals/departures.
- Process approved reservations and authorised check-ins/check-outs.
- Register visitors, issue and return keys, and manage gate-pass workflows where authorised.
- Record incidents and create maintenance requests.
- Handle assigned housekeeping tasks.
  Cannot change system permissions or bypass eligibility and approval rules.




4. Staff / Resident
- View and update permitted personal information.
- Submit accommodation requests and view waitlist/offer status.
- Accept or decline bed offers within the 48-hour offer window.
- View current stay details, accommodation notices and permitted documents.
- Submit maintenance requests and report incidents.
  Scope: own profile, own requests and own accommodation only.




5. Maintenance Coordinator
- View and triage maintenance requests.
- Create, prioritise and assign work orders.
- Track technician assignments, SLAs and overdue work.
- Verify completed work and manage work-order closure.
- View relevant facilities and asset records.




6. Technician
- View assigned work orders.
- Accept jobs and update progress.
- Record work performed, materials and completion notes.
- Submit work for verification.
  Scope: assigned jobs only; no access to staff eligibility or accommodation administration.




7. Vendor / Contractor
- Log in through a restricted contractor portal.
- View only assigned jobs, approved site details and access schedules.
- View or obtain authorised gate passes.
- Record job progress and check-in/check-out where permitted.
- Upload relevant completion evidence.
  No access to resident directories, accommodation allocation, unrelated work orders or internal reports.




8. Security
- View approved visitor and contractor entries.
- Verify gate passes and scheduled access.
- Record entry/exit events and report incidents.
- View only the minimum information needed for access control.
  No access to personal accommodation records beyond authorised operational requirements.




9. Read-only Manager
- View occupancy, capacity, vacancies and operational dashboards.
- View approved reports and performance metrics.
- Export reports only when explicitly authorised.
  No create, edit, approval or deletion rights by default.




10. Auditor
- View immutable audit logs and authorised historical records.
- Review permission changes, overrides, approvals and exceptions.
- Export audit evidence when authorised.
  Read-only access; cannot modify records or audit history.



2. Permission matrix
Default permissions. Every permission remains limited by the user's assigned site, building, job or personal-record scope.
| Module / action | Super Admin | Accommodation Admin | Reception | Resident | Maintenance | Technician | Contractor | Security | Manager | Auditor |
|---|---|---|---|---|---|---|---|---|---|
| Users and roles | Full | Assigned staff | — | Own profile | — | — | — | — | View* | Audit view |
| Sites, rooms and beds | Full | Manage | Operational | View own | Relevant view | Relevant view | Assigned site | Access view | View | Audit view |
| Staff eligibility | Full | Manage | View needed | Own status | — | — | — | Summary* | — | Audit view |
| Requests and waitlist | Full | Manage | Process | Own requests | — | — | — | View | Audit view |
| Reservations and stays | Full | Manage | Process | Own stay | — | — | — | View | Audit view |
| Maintenance / work orders | Full | View/manage* | Create requests | Create own request | Manage | Assigned jobs | Assigned jobs | View | Audit view |
| Visitors and gate passes | Full | Manage* | Process | Own permitted requests | — | — | Own pass | Verify | Summary* | Audit view |
| Reports and exports | Full | Authorised | Limited | Own data | Job reports | Own jobs | Own jobs | Authorised | Audit exports | Audit exports |
| System configuration | Full | Limited* | — | — | — | — | — | — | — | — |
— means no default access. * indicates access should be explicitly granted only when required. Emergency approval, eligibility exceptions and other sensitive actions must follow maker-checker controls.
3. Group assignment rules
- A user may belong to more than one group only when operationally necessary.
- Permissions are the intersection of the group's capabilities and the user's assigned scope; adding a group must not silently expand access to unrelated sites or records.
- High-risk permissions such as role changes, eligibility exceptions and workflow publishing require explicit grants, a reason and audit logging.
- No self-approval for controlled actions.
- Staff who leave the organisation lose login access immediately, while their historical accommodation and audit records remain available to authorised administrators.
- Financial processing and payment permissions remain outside Phase 1 because financial features are deferred to Phase 2.
4. Recommended setup
Start with these 10 groups. Keep housekeeping as a capability under Reception / Accommodation Officer rather than creating a separate group in Phase 1. Keep Line Manager as an optional future group until its approval responsibilities are confirmed.