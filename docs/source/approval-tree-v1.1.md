**GRAND HYATT**

Approval Tree & Decision Checklist

*Staff Accommodation Platform \| Phase 1 \| Version 1.1 Draft*

Prepared by Adpedia \| 14 October 2026

# 1. Purpose and operating principles

This document defines the recommended standard approval routes for Phase
1 so the product team can implement a consistent, auditable workflow.
These are proposed defaults selected for operational clarity; the client
should review and sign off before production configuration.

-   Approval and execution are separate where practical: one person
    decides; another person carries out the action.

-   No user may approve their own request, provisional stay, extension,
    transfer, or controlled exception.

-   Every approval, rejection, escalation and override records the
    actor, timestamp, decision, reason and relevant record state.

-   Timeouts trigger reminders and escalation only. The system must
    never auto-approve, auto-reject, move a resident or check out a
    resident solely because time elapsed.

-   Access is limited by both capability and assigned scope. A
    capability grant adds permitted actions; it never expands
    site/building scope.

-   The Resident role is a base role that may coexist with an
    operational role. Separation-of-duties controls still apply.

-   Phase 1 excludes automated charges, deposits, refunds, payment
    gateway and payroll deductions.

# 2. Approval routes --- recommended default

  ----------------------------------------------------------------------------------------------------------------------------
  **Request /     **Primary decision      **Backup /           **Target**     **Rules / controls**    **Execution / notes**
  action**        owner**                 escalation**                                                
  --------------- ----------------------- -------------------- -------------- ----------------------- ------------------------
  Standard        Accommodation Admin     Super Admin (SA)     2 business     AA verifies             Reception executes only
  accommodation   (AA)                                         days           eligibility,            after approval.
  request                                                                     availability and        
                                                                              priority; SA handles    
                                                                              policy                  
                                                                              exception/escalation.   

  Waitlist        SA                      Named backup SA      2 business     Reason and evidence     AA updates the queue
  priority                                                     days           required; queue history after approval.
  exception                                                                   preserved.              

  Bed offer       Resident                AA for               48 hours to    First decline skips the Offer expires only after
  acceptance      accepts/declines; no    dispute/exception    respond        offer without losing    confirmed delivery or
                  staff approval                                              queue position; second  documented staff
                                                                              decline moves resident  follow-up if delivery is
                                                                              to back of queue.       uncertain.

  Bed allocation  AA                      SA                   Same business  System checks bed       Reception may process
  / reservation                                                day after      availability and        check-in but cannot
  execution                                                    approval       eligibility again at    approve own allocation.
                                                                              execution.              

  Stay extension  AA                      SA                   2 business     Check capacity,         AA updates planned end
  within standard                                              days           eligibility and any     date after approval.
  policy                                                                      conflicting             
                                                                              reservation.            

  Extension       SA                      Named backup SA      2 business     Reason mandatory; no    AA executes approved
  beyond policy /                                              days           self-approval.          change.
  capacity                                                                                            
  exception                                                                                           

  Resident        No approval by default; AA for               Acknowledge    Record intended         Reception completes
  checkout        Reception processes     dispute/exception    within 1       departure and           operational check-out.
  request                                                      business day   checklist; overdue      
                                                                              departure is escalated, 
                                                                              not silently closed.    

  Employee marked AA                      SA                   Same business  Login deactivated       AA owns outstanding
  as Left                                                      day            immediately; clearance  clearance tasks.
                                                                              remains open and        
                                                                              historical records      
                                                                              retained.               

  Transfer / bed  AA                      SA                   2 business     Validate source and     Reception executes
  swap within                                                  days           destination beds,       approved transfer.
  policy                                                                      eligibility and         
                                                                              capacity; prevent       
                                                                              conflicting             
                                                                              allocations.            

  Gender / grade  SA                      Named backup SA      Before         Written reason and      AA executes only after
  eligibility                                                  allocation     supporting evidence     recorded approval.
  exception                                                                   required; all exception 
                                                                              use is reported.        

  Emergency       AA (not the initiator)  Backup approver,     Initial        Reminders every 24      Reception may initiate
  provisional                             then SA escalation   decision       hours; escalate after   only if explicitly
  check-in                                                     within 24      two unanswered          granted; a different
                                                               hours          reminders. No automatic authorised person
                                                                              approval or automatic   approves.
                                                                              checkout.               

  Emergency       SA                      Named backup SA      Initial        Initiator cannot        Record provisional
  provisional                                                  decision       approve their own       status and resolution
  check-in                                                     within 24      provisional stay.       deadline.
  initiated by AA                                              hours                                  

  Work order      Maintenance Coordinator AA for cross-site /  1 business day Urgency and safety      MC assigns to
  assignment      (MC)                    policy exception     for triage     risks drive priority.   technician/contractor.

  Work completion MC or designated        AA for               2 business     Technician or           Verifier records
  verification    independent verifier    disputed/high-risk   days after     contractor cannot       evidence and decision.
                                          closure              completion     verify their own work.  

  Room / bed      Reception/AA designated SA for disputed      Before bed     Cleaner cannot inspect  Only an authorised
  readiness after inspector               exception            becomes        their own room;         inspector changes
  cleaning                                                     Available      occupied beds cannot be readiness to Available.
                                                                              marked ready.           

  Visitor request Reception               AA                   Before visitor Security verifies       No approval grants
  requiring                                                    arrival        identity and records    access outside the
  approval                                                                    physical gate           approved time/site.
                                                                              entry/exit.             

  Contractor      MC for job-related      SA                   Before         Contractor sees         Contractor records job
  access / gate   access; AA for                               scheduled      assigned jobs only;     start/finish, not gate
  pass            accommodation-related                        arrival        Security records gate   entry/exit.
                  access                                                      check-in/out.           

  Night key issue Security with Night     AA                   At each        Record key, recipient,  Security may issue only
  / return        Keys capability                              issue/return   time and return status; authorised keys.
                                                                              missing keys escalated  
                                                                              to AA.                  

  SOS / serious   Security acknowledges   SA or designated     Immediate / as Escalation is based on  Closure by designated
  incident        and responds; AA        emergency contact    soon as        severity; never wait    incident owner after
                  coordinates                                  practicable    for routine approval    actions are recorded.
                  accommodation response                                      before emergency        
                                                                              response.               

  Permission /    Independent authorised  Second SA /          Before change  Requester cannot        Changes logged with
  role change     SA (maker-checker)      designated           takes effect   approve their own       before/after values and
                                          governance approver                 change; last active SA  reason.
                                                                              protected.              

  Workflow        Independent SA          Second SA /          Before change  Preview impact and      Hard delete not
  publish / bulk  (maker-checker)         designated           takes effect   record reason; routine  available in Phase 1.
  archive /                               governance approver                 deletion disabled.      
  retention                                                                                           
  change                                                                                              

  Outage export   Reception with explicit AA                   When outage    Watermarked             Export does not reserve
                  Outage Export                                declared /     minimal-data snapshot;  beds or guarantee
                  capability                                   controlled     reconcile after service vacancy.
                                                               need           returns.                
  ----------------------------------------------------------------------------------------------------------------------------

# 3. Escalation tree

  ---------------------------------------------------------------------------
  **Situation**         **First step**    **If overdue /    **Final route**
                                          unavailable**     
  --------------------- ----------------- ----------------- -----------------
  Routine approval      Notify primary    Reminder at       SA if still
  pending               approver          defined deadline; unresolved
                                          route to backup   

  Emergency provisional AA or authorised  Reminder every 24 SA escalation; no
  stay                  approver;         hours; after two  auto-approval
                        decision due      unanswered        
                        within 24 hours   reminders route   
                                          to backup         

  Primary approver is   Block             Route to an       SA or named
  requester/initiator   self-approval     independent       backup SA
                                          approver          

  Safety incident / SOS Security          Notify AA and     SA / emergency
                        acknowledges and  designated        contact according
                        responds          emergency contact to severity
                        immediately                         

  Approver absent or    Use named backup  If backup         No decision by an
  account disabled      approver          unavailable,      unauthorised user
                                          route to SA       

  No second Super Admin Do not silently   Route to a        Otherwise hold
  available for         bypass the        separately        the change and
  maker-checker         control           designated        log the blocker
                                          governance        
                                          approver only if  
                                          formally          
                                          authorised        
  ---------------------------------------------------------------------------

# 4. Role and capability assignment checklist

> ☐ Create the 10 Phase 1 groups: Super Admin, Accommodation Admin,
> Reception/Accommodation Officer, Staff/Resident, Maintenance
> Coordinator, Technician, Vendor/Contractor, Security, Read-only
> Manager and Auditor.
>
> ☐ Treat Resident as a base role that may coexist with an operational
> role.
>
> ☐ Keep Housekeeping as a capability on a staff account; never assign a
> user to clean or inspect their own room.
>
> ☐ Grant Building Creation to Accommodation Admin only explicitly and
> only within assigned sites. Site reassignment remains a Super Admin
> responsibility.
>
> ☐ Grant Emergency Check-in initiation to specifically authorised
> Reception/AA users; approval must be independent.
>
> ☐ Assign named primary and backup approvers, including at least one
> escalation contact for provisional stays.
>
> ☐ Grant Night Keys to designated Security users only.
>
> ☐ Grant Outage Export to designated Reception users only; watermark
> exports and record download events.
>
> ☐ Keep Vendor/Contractor access restricted to assigned jobs, site
> details and authorised gate-pass information.
>
> ☐ Keep Auditor read-only, with full audit-log viewing and no ability
> to modify audit data.
>
> ☐ Do not give Read-only Manager user/role access; reports are
> operational, with exports only by explicit grant.
>
> ☐ Confirm all site/building scopes before activating accounts. Action
> grants must never widen those scopes.

# 5. Approval audit and separation-of-duties checklist

> ☐ Each approval route has a primary approver role and a named backup
> or escalation route.
>
> ☐ Each controlled request records requester, approver, decision,
> timestamp, reason and state before/after.
>
> ☐ Self-approval is technically blocked in the API, not only hidden in
> the UI.
>
> ☐ Approval decisions and permissions are checked server-side for every
> action.
>
> ☐ No timeout automatically approves, rejects, checks out, reallocates
> or moves a resident.
>
> ☐ Technicians and contractors cannot verify their own work.
>
> ☐ Housekeeping staff cannot clean or inspect their own room; final
> inspection is performed by another authorised user.
>
> ☐ A person cannot process their own request, allocate themselves a bed
> or approve their own extension.
>
> ☐ Overrides require a reason, are visibly flagged and notify the
> original approver where applicable.
>
> ☐ Role/permission changes use maker-checker; the last active Super
> Admin cannot be removed or downgraded.
>
> ☐ Audit logs are immutable and available to Auditor in read-only mode.
>
> ☐ Former staff login is deactivated immediately on status change to
> Left; clearance and history remain available to administrators.

# 6. Client confirmation checklist

The routes above are the recommended standard defaults. Confirm or amend
the following before configuration:

> ☐ Confirm primary and backup approver names for each role-based route.
>
> ☐ Confirm the routine approval SLA of 2 business days and maintenance
> triage SLA of 1 business day.
>
> ☐ Confirm the emergency escalation contact and who is authorised to
> act as backup approver.
>
> ☐ Confirm whether any accommodation request category should be
> auto-approved. Default recommendation: no auto-approval in Phase 1.
>
> ☐ Confirm visitor approval policy and who may approve visitor
> exceptions.
>
> ☐ Confirm incident severity levels and emergency contact details
> outside the application.
>
> ☐ Confirm who is authorised as the independent governance approver if
> two Super Admins are not available.
>
> ☐ Confirm retention periods and applicable legal/privacy requirements.

# 7. Sign-off

  ---------------------------------------------------------------------------------------------------------------------------------------
  **Field**                           **Client response**
  ----------------------------------- ---------------------------------------------------------------------------------------------------
  Client / department                 \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

  Reviewed by                         \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

  Date                                \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

  Status                              ☐ Approved ☐ Approved with changes ☐ Pending

  Outstanding changes / comments      \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\
                                      \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
  ---------------------------------------------------------------------------------------------------------------------------------------

**Implementation note:** This document defines a proposed standard
approval model for Phase 1 planning. Any client-specific policy or
statutory requirement takes precedence after formal confirmation. Do not
configure unresolved routes as silent defaults.
