# Staff Accommodation Platform — Corrected End-to-End User Journey

The correct approach is to design this as one connected accommodation lifecycle with separate role-based journeys, rather than treating the 22 modules as independent features.

I've used the uploaded document's role definitions, record lifecycles, data ownership rules and edge cases as the baseline. I've also carried forward your requirement that a room can contain multiple individually managed beds, with accurate capacity, occupancy and vacancy tracking.

The revised flow below distinguishes between requirements already present in the document and the additional rules needed to make the system work reliably.

## 1. The complete system journey

1\. Organization setup

Sites, buildings, room types, permissions, policies and workflows

2\. Staff onboarding and eligibility

HRMS, import or manual entry → verification → accommodation eligibility

3\. Bed inventory and allocation

Room capacity → individual bed availability → request → approval → reservation

4\. Arrival and check-in

Identity and reservation verification → room readiness → keys and assets → active stay

5\. Active resident lifecycle

Self-service, maintenance, visitors, facilities, notifications and incidents

6\. Checkout and clearance

Exit trigger → checkout tasks → keys/assets → inspection → clearance

7\. Bed turnover and closure

Needs cleaning → cleaning verification → available bed → next allocation

Cross-cutting throughout: authorization, audit logs, notifications, approval routing, reporting and exception handling.

This lifecycle reflects the source document's staff/resident and bed status flows, structure rules and exit edge cases.&#x20;

Staff Accommodation Platform – Roles, Permissions & Module Map.docx

Staff Accommodation Platform – Roles, Permissions & Module Map.docx



## 2. Journey A — Super Admin configures the platform

Primary role: Super Admin

1. Create the organization. Configure organization details, time zone, calendars, master data and global policies.
2. Create the site hierarchy. Create sites and buildings, then configure floors, units, rooms and individual beds.
3. Configure room and bed rules. Define capacity, room type, gender and eligibility restrictions, amenities, bed types and applicable charges.
4. Assign administrators. Scope each Accommodation Admin to specific sites or buildings. Access grants must never extend that scope.
5. Configure workflows. Set approval routes, SLA targets, escalations, delegation, notification templates and audit requirements.
6. Validate and activate. Preview the site structure, resolve validation errors, and activate it before its beds become eligible for allocation.

### Corrections to this journey

- A site or building cannot become operational with invalid or incomplete room/bed structures.
- The room's capacity must equal the permitted number of active beds, unless a deliberately defined alternative capacity rule exists.
- Blocking a building must prevent allocations throughout its hierarchy.
- Reducing capacity below occupancy or active reservations must be blocked until the conflicts are resolved.
- Archiving must check occupants, reservations, keys and assets before allowing the operation.

The source already establishes the hierarchy and many of these restrictions. The additional validation gates make them explicit prerequisites for going live.&#x20;

Staff Accommodation Platform – Roles, Permissions & Module Map.docx



## 3. Journey B — Staff onboarding to accommodation allocation

Primary roles: Accommodation Admin, Resident, Officer / Reception

\#chatgpt-mermaid-\_r_oc\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_oc\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_oc\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_oc\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_oc\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_oc\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_oc\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_oc\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_oc\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_oc\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_oc\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_oc\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_oc\_ p{margin:0;}#chatgpt-mermaid-\_r_oc\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_oc\_ .label text,#chatgpt-mermaid-\_r_oc\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .node rect,#chatgpt-mermaid-\_r_oc\_ .node circle,#chatgpt-mermaid-\_r_oc\_ .node ellipse,#chatgpt-mermaid-\_r_oc\_ .node polygon,#chatgpt-mermaid-\_r_oc\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .rough-node .label text,#chatgpt-mermaid-\_r_oc\_ .node .label text,#chatgpt-mermaid-\_r_oc\_ .image-shape .label,#chatgpt-mermaid-\_r_oc\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_oc\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .rough-node .label,#chatgpt-mermaid-\_r_oc\_ .node .label,#chatgpt-mermaid-\_r_oc\_ .image-shape .label,#chatgpt-mermaid-\_r_oc\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_oc\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_oc\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_oc\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_oc\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_oc\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_oc\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_oc\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_oc\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_oc\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_oc\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_oc\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_oc\_ .icon-shape,#chatgpt-mermaid-\_r_oc\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_oc\_ .icon-shape p,#chatgpt-mermaid-\_r_oc\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_oc\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_oc\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_oc\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_oc\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_oc\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_oc\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_oc\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_oc\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_oc\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_oc\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_oc\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_oc\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_oc\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_oc\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_oc\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_oc\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .node rect,#chatgpt-mermaid-\_r_oc\_ .node circle,#chatgpt-mermaid-\_r_oc\_ .node ellipse,#chatgpt-mermaid-\_r_oc\_ .node polygon,#chatgpt-mermaid-\_r_oc\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_oc\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_oc\_ .node.mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_oc\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_oc\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_oc\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Staff record receivedSourceHRMS syncValidated CSV importManual entryMatch existing employeeDuplicate or conflict?Review and mergeVerify staff profileEligible for accommodation?Record reason and nextactionCreate or enable residentaccountSubmit accommodationrequestCheck policy and bedavailabilitySuitable bed available?Waitlist and notifyRecheck when a suitable bedbecomes availableApproval if requiredReserve bed atomicallySend arrival instructionsYesNoNoYesNoYes

### Corrected functional sequence

1. Create the staff profile from HRMS, a validated import or an authorized manual entry.
2. Match on the configured employee identifier; use duplicate review instead of creating a second employee record.
3. Verify mandatory data and determine eligibility from the applicable policy.
4. Create the resident account only when the profile and access prerequisites are met.
5. Let an eligible resident submit a request, or let an authorized administrator create one on their behalf.
6. Validate eligibility, site and room restrictions, intended dates, capacity and existing reservations.
7. Route the request for approval only if the configured policy requires it.
8. Reserve a specific bed only after all required approvals are complete.
9. Notify the resident and provide the arrival date, site, room, bed and required instructions.

Important correction: An accommodation request is not a bed reservation, and a reservation is not an active stay. Those must be distinct records or distinct states with their own rules.

### Gap fixes

- If there is no suitable bed, the system should offer a waitlist rather than silently fail.
- Waitlist priority must be configurable and visible to authorized administrators; the system must not promise a bed until it is reserved.
- If a staff member becomes ineligible before check-in, the reservation must be revalidated and routed for an authorized decision.
- If a reservation expires, is cancelled or is rejected, the bed must be released correctly.
- If HRMS reports an employee exit before check-in, cancel the reservation and release the bed, as the document requires.
- A bed must never be allocated to two residents, even if two administrators submit at the same time.

The last rule must be enforced with a database transaction or equivalent atomic reservation mechanism, not merely a front-end availability check.

## 4. Journey C — Site, room and bed management

Primary role: Accommodation Admin · Super Admin owns site and building structure

The bed should be the fundamental unit of occupancy. A room is a container for beds, not the occupancy record itself.

### Example room inventory

Building A · Floor 2 · Room 204

## 4-bed room

2 occupied

1 reserved

1 available

| Bed   | Status    | Allocation   |
| ----- | --------- | ------------ |
| 204-A | Occupied  | Employee 101 |
| 204-B | Occupied  | Employee 102 |
| 204-C | Reserved  | Employee 103 |
| 204-D | Available | —            |

Illustrative data. A reserved bed is not vacant for new allocation, even though its occupant has not checked in.

### Required inventory rules

- Each bed has a unique identifier and an independently managed status.
- Total capacity, occupied beds, reserved beds, available beds, blocked beds, beds under maintenance and beds needing cleaning must be reported separately.
- A bed in an inactive building, blocked room or unavailable state cannot be allocated.
- A bed must not be marked available merely because a resident's checkout was recorded; it must pass the required turnover and readiness checks.
- A room cannot be archived while it has residents, active reservations, unretired keys or assets that still need reassignment.
- Changes to capacity or room restrictions must trigger conflict validation against both current stays and future reservations.

Correct vacancy formula:

\\[ \text{Available beds} = \text{Active beds eligible for allocation} - \text{Beds occupied or reserved} \\]

This is a conceptual formula. The actual implementation should calculate availability using bed status, allocation dates, reservation windows, restrictions and maintenance/cleaning blocks, so the same bed is not counted twice or offered when unavailable.

## 5. Journey D — Arrival, check-in and active stay

Primary roles: Officer / Reception and Accommodation Admin

\#chatgpt-mermaid-\_r_nq\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_nq\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_nq\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_nq\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_nq\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_nq\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_nq\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_nq\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_nq\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_nq\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_nq\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_nq\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_nq\_ p{margin:0;}#chatgpt-mermaid-\_r_nq\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_nq\_ .label text,#chatgpt-mermaid-\_r_nq\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .node rect,#chatgpt-mermaid-\_r_nq\_ .node circle,#chatgpt-mermaid-\_r_nq\_ .node ellipse,#chatgpt-mermaid-\_r_nq\_ .node polygon,#chatgpt-mermaid-\_r_nq\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .rough-node .label text,#chatgpt-mermaid-\_r_nq\_ .node .label text,#chatgpt-mermaid-\_r_nq\_ .image-shape .label,#chatgpt-mermaid-\_r_nq\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_nq\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .rough-node .label,#chatgpt-mermaid-\_r_nq\_ .node .label,#chatgpt-mermaid-\_r_nq\_ .image-shape .label,#chatgpt-mermaid-\_r_nq\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_nq\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_nq\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_nq\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_nq\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_nq\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_nq\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_nq\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_nq\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_nq\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_nq\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_nq\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_nq\_ .icon-shape,#chatgpt-mermaid-\_r_nq\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_nq\_ .icon-shape p,#chatgpt-mermaid-\_r_nq\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_nq\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_nq\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_nq\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_nq\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_nq\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_nq\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_nq\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_nq\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_nq\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nq\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_nq\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_nq\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_nq\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_nq\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_nq\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_nq\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .node rect,#chatgpt-mermaid-\_r_nq\_ .node circle,#chatgpt-mermaid-\_r_nq\_ .node ellipse,#chatgpt-mermaid-\_r_nq\_ .node polygon,#chatgpt-mermaid-\_r_nq\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_nq\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_nq\_ .node.mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_nq\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_nq\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_nq\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Resident arrivesFind reservationIdentity and stay valid?Hold check-in and escalateCheck bed and roomreadinessReady and eligible?Resolve readiness orreassign bedComplete check-in checklistRecord key and assethandoverActivate stay and mark bedoccupiedEnable resident self-serviceNotify resident and updateoccupancyNoYesNoYes

### Corrected check-in rules

1. Search by employee ID, reservation code or authorized staff lookup.
2. Verify identity, reservation dates, eligibility and actual bed assignment.
3. Confirm the bed is active, ready, unblocked and not already occupied.
4. Complete mandatory check-in checklist items and house-rule acknowledgements.
5. Record keys issued and room assets handed over.
6. Commit the check-in, active stay and bed status update as one consistent operation.
7. Enable the resident's full stay-related access and update dashboards and reports.

### If something goes wrong

- No reservation: Route to the authorized exception process; do not silently create an ordinary check-in.
- Emergency check-in: Create a provisional stay only for an authorized Officer with the Emergency Check-in grant. Create an approval task due within 24 hours. If rejected, create a move or checkout task with a deadline.
- Bed unavailable: Do not overwrite its status. Reassign to another eligible bed through a controlled operation.
- Missing key or asset: Record the exception and follow the configured policy rather than falsely marking the handover complete.
- Duplicate check-in request: Return the existing result or safely reject the duplicate; do not create another active stay.

The emergency grant and 24-hour approval requirement are already specified in the source document. The additional transaction and failure-handling rules prevent inconsistent records.

## 6. Journey E — Resident self-service

Primary role: Staff / Resident

The resident should have one simple mobile-first journey that adapts to their accommodation status.

Before allocation

Apply for accommodation, view eligibility, track request/approval status and receive waitlist updates.

After reservation

View arrival details, assigned location, required documents, instructions and reservation status.

During the stay

View own stay, submit maintenance requests, book facilities, manage visitors, read announcements, report lost items and raise SOS.

During checkout

View checkout checklist, return instructions, outstanding actions and clearance progress.

### Gaps to correct

- Every request needs a unique reference, status, history and next action.
- Residents should be able to see whether their request is awaiting approval, assigned, on hold, resolved or closed.
- A resident must not see other residents' phone numbers, documents, requests or private details. Roommate visibility should remain limited to the approved fields.
- Cancellation and modification policies must be shown before submitting bookings or requests.
- Checked-out users should retain only the limited historical access defined by policy; account deactivation and retention must not erase required audit history.
- SOS needs a clear receiving role, escalation path, acknowledgement, response tracking and closure record.

## 7. Journey F — Maintenance, housekeeping and inventory

Primary roles: Resident, Officer, Maintenance Coordinator, Technician and Vendor / Contractor

\#chatgpt-mermaid-\_r_p2\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_p2\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_p2\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_p2\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_p2\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_p2\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_p2\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_p2\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_p2\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_p2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_p2\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_p2\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_p2\_ p{margin:0;}#chatgpt-mermaid-\_r_p2\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_p2\_ .label text,#chatgpt-mermaid-\_r_p2\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .node rect,#chatgpt-mermaid-\_r_p2\_ .node circle,#chatgpt-mermaid-\_r_p2\_ .node ellipse,#chatgpt-mermaid-\_r_p2\_ .node polygon,#chatgpt-mermaid-\_r_p2\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .rough-node .label text,#chatgpt-mermaid-\_r_p2\_ .node .label text,#chatgpt-mermaid-\_r_p2\_ .image-shape .label,#chatgpt-mermaid-\_r_p2\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_p2\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .rough-node .label,#chatgpt-mermaid-\_r_p2\_ .node .label,#chatgpt-mermaid-\_r_p2\_ .image-shape .label,#chatgpt-mermaid-\_r_p2\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_p2\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_p2\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_p2\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_p2\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_p2\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_p2\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_p2\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_p2\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_p2\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_p2\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_p2\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_p2\_ .icon-shape,#chatgpt-mermaid-\_r_p2\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_p2\_ .icon-shape p,#chatgpt-mermaid-\_r_p2\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_p2\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_p2\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_p2\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_p2\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_p2\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_p2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_p2\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_p2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_p2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_p2\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_p2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_p2\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_p2\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_p2\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_p2\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_p2\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .node rect,#chatgpt-mermaid-\_r_p2\_ .node circle,#chatgpt-mermaid-\_r_p2\_ .node ellipse,#chatgpt-mermaid-\_r_p2\_ .node polygon,#chatgpt-mermaid-\_r_p2\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_p2\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_p2\_ .node.mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_p2\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_p2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_p2\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Issue reported or inspectionfailedCreate work orderTriage priority and SLAAssign technician or vendorAccept and start jobBlocked?On hold with reason and nextactionRecord work, parts, photosand costCost approval required?Authorized cost approvalResolve jobIndependent verificationPass?Reopen or return forcorrectionClose and auditYesNoYesNoNoYes

### Corrected rules

1. Every issue creates a linked work order, whether raised by a resident, reception, inspection or scheduled maintenance.
2. Assign a priority, SLA, site, room/bed reference and responsible team.
3. Technicians and contractors see only jobs assigned to them and the minimum resident information necessary.
4. A hold requires a reason, such as parts, access, vendor availability or pending approval, plus a next action.
5. Parts issued against a work order must update inventory and leave a traceable stock movement.
6. High-risk work permits and costs above the configured threshold must be approved before the relevant work or commitment proceeds.
7. Completion requires work notes, evidence and an outcome.
8. Verification must be performed by an authorized person who did not perform the work, where separation of duties is required.
9. Failed verification reopens or returns the job for correction.
10. Closing a maintenance job must not automatically make a bed available unless the required maintenance, cleaning and readiness conditions are all satisfied.

Key correction: Maintenance completion and bed readiness are separate states. A technician may resolve a repair, but the room may still need cleaning or inspection before a resident can be allocated to it.

## 8. Journey G — Transfers, extensions and room changes

Primary roles: Resident, Accommodation Admin and Officer / Reception

These operations must use a controlled transition rather than directly editing a resident's room field.

1. Resident or an authorized administrator submits a transfer or extension request.
2. The system validates eligibility, approval requirements, the existing stay, the target bed and date conflicts.
3. The approval workflow runs according to policy. The requester cannot approve their own request or exception.
4. For an approved transfer, reserve the destination bed before releasing the source bed.
5. Coordinate old-room checkout, key return, asset handover, new-room check-in and any required inspection.
6. Commit the transfer, update the stay/bed relationships, cancel incompatible future bookings and preserve the movement history.

### Corrected rules

- Bed swap: Swap two residents atomically. Never leave either resident without an assigned bed during the operation.
- Same-site transfer: Validate availability within the same site's policy.
- Inter-site transfer: Validate eligibility at the destination and coordinate both sites' approvals and handovers.
- Extension: Recheck future reservations and competing allocations before extending the current stay.
- Failed transfer: If the destination is unavailable or a required step fails, preserve the original valid stay and do not partially move the resident.
- No-show: Define when a reservation expires, who can extend the arrival window and when the bed is released.

## 9. Journey H — Checkout, exit and bed turnover

Primary roles: Accommodation Admin, Officer / Reception, Resident and Housekeeping

This is one of the most important journeys because the next employee may be waiting for the same bed.

\#chatgpt-mermaid-\_r_pb\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_pb\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_pb\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_pb\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_pb\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_pb\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_pb\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_pb\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_pb\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_pb\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pb\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pb\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_pb\_ p{margin:0;}#chatgpt-mermaid-\_r_pb\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_pb\_ .label text,#chatgpt-mermaid-\_r_pb\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .node rect,#chatgpt-mermaid-\_r_pb\_ .node circle,#chatgpt-mermaid-\_r_pb\_ .node ellipse,#chatgpt-mermaid-\_r_pb\_ .node polygon,#chatgpt-mermaid-\_r_pb\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .rough-node .label text,#chatgpt-mermaid-\_r_pb\_ .node .label text,#chatgpt-mermaid-\_r_pb\_ .image-shape .label,#chatgpt-mermaid-\_r_pb\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_pb\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .rough-node .label,#chatgpt-mermaid-\_r_pb\_ .node .label,#chatgpt-mermaid-\_r_pb\_ .image-shape .label,#chatgpt-mermaid-\_r_pb\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_pb\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_pb\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pb\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pb\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_pb\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_pb\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pb\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pb\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_pb\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_pb\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pb\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_pb\_ .icon-shape,#chatgpt-mermaid-\_r_pb\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_pb\_ .icon-shape p,#chatgpt-mermaid-\_r_pb\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_pb\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_pb\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pb\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_pb\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_pb\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_pb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_pb\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_pb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_pb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pb\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_pb\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pb\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_pb\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_pb\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_pb\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_pb\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .node rect,#chatgpt-mermaid-\_r_pb\_ .node circle,#chatgpt-mermaid-\_r_pb\_ .node ellipse,#chatgpt-mermaid-\_r_pb\_ .node polygon,#chatgpt-mermaid-\_r_pb\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_pb\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_pb\_ .node.mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_pb\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_pb\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pb\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Exit trigger or approvedcheckoutCreate checkout checklistCancel future bookings andvisitor passesInspect outstandingrequests, keys, assets andchargesResident leaves and keyreturn is recordedComplete room inspectionOutstanding items?Record return, loss orauthorized exceptionResolve clearancerequirementsComplete clearance and endstaySet bed to Needs cleaningCleaning task completedInspection/readiness check ifrequiredReady?Create cleaning ormaintenance taskSet bed AvailableEligible for next allocationYesNoNoYes

### Corrected checkout rules

1. Create the checkout task when the employee exits, a valid checkout request is approved or the configured HR exit process triggers it.
2. Show all outstanding keys, assets, requests and applicable charges.
3. Record actual key and asset returns, or record losses through the authorized exception process.
4. Cancel future bookings and visitor passes according to the exit rules.
5. Record the final room inspection and create work orders for any damage or maintenance.
6. Complete clearance only when mandatory requirements are satisfied or formally waived by an authorized approver.
7. End the active stay and mark the bed as needing cleaning.
8. Complete cleaning and any required readiness inspection.
9. Mark the bed available only when all allocation prerequisites pass.

### Essential distinction

The system must track three different outcomes:

- Stay ended: The resident no longer occupies the bed.
- Clearance completed: The employee's exit obligations have been resolved or validly waived.
- Bed ready: The physical bed is suitable for the next resident.

These outcomes are related but not interchangeable. A bed can be vacant and still unavailable.

For abandoned rooms, absconding or death, the source specifies an Accommodation Admin-only procedure with belongings inventory, HR notification and an audit trail. This should be a dedicated exception workflow rather than an ordinary checkout shortcut.

## 10. Journey I — Visitors, security and facilities

### Visitor and contractor access

\#chatgpt-mermaid-\_r_pk\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_pk\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_pk\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_pk\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_pk\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_pk\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_pk\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_pk\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_pk\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_pk\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pk\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pk\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_pk\_ p{margin:0;}#chatgpt-mermaid-\_r_pk\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_pk\_ .label text,#chatgpt-mermaid-\_r_pk\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .node rect,#chatgpt-mermaid-\_r_pk\_ .node circle,#chatgpt-mermaid-\_r_pk\_ .node ellipse,#chatgpt-mermaid-\_r_pk\_ .node polygon,#chatgpt-mermaid-\_r_pk\_ .node path{fill:rgb(9, 23, 44);stroke:rgb(31, 78, 148);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .rough-node .label text,#chatgpt-mermaid-\_r_pk\_ .node .label text,#chatgpt-mermaid-\_r_pk\_ .image-shape .label,#chatgpt-mermaid-\_r_pk\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_pk\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .rough-node .label,#chatgpt-mermaid-\_r_pk\_ .node .label,#chatgpt-mermaid-\_r_pk\_ .image-shape .label,#chatgpt-mermaid-\_r_pk\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_pk\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_pk\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pk\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pk\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_pk\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_pk\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pk\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pk\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_pk\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_pk\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_pk\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_pk\_ .icon-shape,#chatgpt-mermaid-\_r_pk\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_pk\_ .icon-shape p,#chatgpt-mermaid-\_r_pk\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_pk\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_pk\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_pk\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_pk\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_pk\_ .node .neo-node{stroke:rgb(31, 78, 148);}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_pk\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_pk\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node .neo-line path{stroke:rgb(31, 78, 148);filter:none;}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_pk\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_pk\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pk\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_pk\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_pk\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_pk\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(153, 206, 255);}#chatgpt-mermaid-\_r_pk\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_pk\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_pk\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .node rect,#chatgpt-mermaid-\_r_pk\_ .node circle,#chatgpt-mermaid-\_r_pk\_ .node ellipse,#chatgpt-mermaid-\_r_pk\_ .node polygon,#chatgpt-mermaid-\_r_pk\_ .node path{fill:rgb(0, 40, 77);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_pk\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_pk\_ .node.mermaid-decision .label-container{fill:rgb(0, 14, 26);stroke:rgb(26, 62, 95);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_pk\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_pk\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_pk\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Visitor pre-registration orwalk-inValidate resident, policy andvisit windowApproval required?Resident or authorizedapprover decidesPrepare approved entryApproved?Deny and record reasonSecurity verifies identity andauthorizationValid pass and entryconditions?Record check-inTrack presence and overstayRecord checkoutClose visit and retain auditYesNoNoYesNoYes

For contractors, additionally validate:

- Vendor status and contract validity.
- Worker documents and required verification.
- Assigned work order and authorized site.
- Approved visit window and any escort requirements.
- Keys issued and returned.
- Revocation during a visit, including an alert to Security and a recovery/reassignment process.

A valid contractor job assignment alone must not grant unrestricted access to other sites, rooms or records.

### Facility booking

The corrected booking lifecycle should be:

`Requested → Pending approval (if required) → Confirmed → Checked in → Completed`

Alternative states are `Rejected`, `Cancelled`, `Waitlisted` and `No-show`.

Required controls:

- Validate availability, eligibility, booking duration and capacity.
- Prevent overlapping bookings beyond the facility's capacity.
- Recheck availability atomically when confirming a booking.
- On facility closure, cancel affected bookings, notify residents and handle waitlists.
- Apply no-show restrictions only according to a configured policy.
- Distinguish booking cancellation from an actual no-show.

### Incidents and SOS

SOS should have a separate priority path from ordinary maintenance:

`Raised → Acknowledged → Response in progress → Resolved → Closed`

Escalation must occur when acknowledgement or response deadlines are missed. Incident records should preserve the original report, response actions, timestamps, responsible users and closure reason.

## 11. Corrected global approval journey

The source defines configurable workflows, delegation, escalation, approval inboxes and maker-checker controls. To make these consistent across modules, use one shared approval engine.

Request submitted

Validate required fields, scope and policy

Approval route resolved

Determine approvers, order, thresholds and deadlines

Approver acts

Approve, reject, request information or delegate if allowed

Approved

Execute the requested operation

Rejected

Record reason and notify requester

Audit and notify

Record decision, update status and notify relevant users

### Rules that must apply across all modules

1. A user cannot approve their own request or an exception they raised.
2. An approver must have permission for the request type and the relevant scope.
3. Delegation must be explicit, time-limited where appropriate, and audited.
4. Rejection must capture a reason and must not execute the underlying action.
5. An approval timeout must trigger the configured escalation, not silently approve the request.
6. Retries must not execute an approved action twice.
7. Approval policy changes should affect pending requests according to an explicit versioning rule.
8. If an approver is deactivated or loses scope, pending approvals must be reassigned before the change is finalized.
9. High-risk operations must apply the maker-checker requirement specified by policy.
10. Every decision must retain who acted, when, the decision, reason and applicable policy/version.

Correction: Approval is not execution. The system must distinguish between `Approved` and `Executed` so that an approved transfer, charge, reservation or exception cannot be incorrectly reported as completed before the operation succeeds.

## 12. Unified status model — final corrections

The source document provides the main status lifecycles. The following table consolidates them and adds the missing transition rules needed to avoid inconsistent states.

| Record                | Correct primary lifecycle                                                        | Important exception handling                               |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Staff profile         | Unverified → Eligible / Ineligible → Archived                                    | Duplicate review, rehire, HR exit                          |
| Accommodation request | Draft → Submitted → Pending approval → Approved / Rejected → Executed → Closed   | Cancelled, escalated, delegated                            |
| Reservation           | Requested → Pending approval if required → Reserved → Checked in                 | Waitlisted, expired, cancelled, no-show                    |
| Stay                  | Reserved → Checked in → Checkout due → Checked out                               | Provisional stay, overstay, emergency exit                 |
| Bed                   | Draft → Available → Reserved → Occupied → Needs cleaning → Available             | Blocked, under maintenance, archived                       |
| Work order            | New → Triaged → Assigned → Accepted → In progress → Resolved → Verified → Closed | On hold, reopened, cancelled                               |
| Facility booking      | Requested → Confirmed → Checked in → Completed                                   | Pending approval, rejected, cancelled, no-show, waitlisted |
| Visitor               | Pre-registered → Approved → Checked in → Checked out                             | Denied, walk-in pending confirmation, overstay             |
| Contractor visit      | Scheduled → Gate pass issued → Checked in → Checked out                          | Invalid contract, documents, time window or escort         |
| Key                   | In cabinet → Issued → Returned                                                   | Overdue, lost, damaged, retired                            |
| Clearance             | Pending → In progress → Completed                                                | Blocked by outstanding items, authorized waiver            |
| Cleaning task         | Created → Assigned → In progress → Completed → Verified if required              | Rework, blocked, cancelled with reason                     |

Staff Accommodation Platform – Roles, Permissions & Module Map.docx

### Mandatory status-engine rules

These should be implemented once and reused throughout the platform.

- Every status transition has an authorized actor, preconditions and audit event.
- Invalid transitions are rejected by the backend.
- Related records are updated transactionally where required.
- Failed operations must roll back or enter a recoverable state.
- Status changes trigger only the relevant notifications and follow-up tasks.
- Closed records retain their history; reopening requires explicit permission and a reason.
- Dashboards and reports derive from the same persisted status definitions.
- No-show, timeout and SLA rules must specify the responsible system action and whether manual review is required.

## 13. Critical flow gaps and their corrections

This is the consolidated list I would use as the development team's remediation checklist.

### Development remediation checklist

3/15

Double allocation or double booking

Critical

Enforce atomic reservation and capacity checks in the database; make retries idempotent.

Bed marked vacant before it is ready

Critical

Separate stay closure, clearance and bed readiness. Require cleaning and any configured inspection.

UI permissions without API enforcement

Critical

Apply module, action, record scope and state-transition authorization on every protected endpoint.

Approval recorded but action not completed

Critical

Separate approval from execution; track execution outcome and recover failures safely.

Unauthorized emergency check-in

Critical

Require the explicit grant, record the override, create the 24-hour approval task and handle rejection.

Missing or conflicting HR records

High

Define employee matching, source-of-truth fields, conflict review and retryable synchronization.

Transfers that partially complete

High

Reserve destination first, preserve the source stay on failure and coordinate keys/assets.

Checkout blocked by missing assets or keys

High

Use explicit return, loss and authorized-waiver outcomes; never silently bypass clearance.

Maintenance completed but room unavailable

High

Keep repair status separate from cleaning, inspection and allocation readiness.

Approver deactivated or unavailable

High

Reassign pending work, define delegation and escalate missed deadlines.

Vendor access outlives authorization

High

Validate contract, documents, assigned job and visit window at entry and during the visit.

Notifications fail or are duplicated

High

Use retryable delivery, delivery status, deduplication and in-app notifications for important actions.

Audit or reporting inconsistency

High

Use immutable audit events, consistent status definitions and permission-filtered report queries.

Undefined cancellation and no-show policy

Medium

Configure cutoffs, grace periods, release rules, waitlist handling and applicable restrictions.

Unclear finance scope

Medium

Decide phase 1 charge types, approvals, waivers, reversals and payroll/finance exports.

&#x20;Copy remediation checklist

## 14. Recommended navigation and dashboard structure

The system should use role-based navigation, not expose all modules to all users.

| Role                    | Primary navigation                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Super Admin             | Overview, Organization, Sites, Access, Workflows, Integrations, Operations, Reports, Audit                   |
| Accommodation Admin     | Overview, Staff, Allocations, Transfers, Approvals, Room & Bed Inventory, Keys, Assets, Facilities, Reports  |
| Officer / Reception     | Front Desk, Arrivals, Departures, Residents, Room Readiness, Keys, Facilities Today, Lost & Found, Shift Log |
| Resident                | Home, My Stay, Requests, Facilities, More                                                                    |
| Maintenance Coordinator | Overview, Work Orders, Assignment Board, Preventive Maintenance, Vendors, Permits, Reports                   |
| Technician / Contractor | My Jobs, Job Details, Parts, Work History                                                                    |
| Security                | Gate, Visitors, Contractor Visits, Incidents, Parcels, SOS, Shift Log                                        |
| Read-only Manager       | Executive Dashboard, Operational Reports, Scheduled Reports                                                  |
| Auditor                 | Audit Log, Exceptions, Reports                                                                               |

The Line Manager should receive a secure, authenticated approval journey rather than unrestricted access to the admin dashboard.

### What every dashboard must answer

- What needs my attention now?
- What is due today?
- Which tasks are overdue?
- What is blocked and why?
- What can I do next with my permissions?
- Which site or building am I viewing?

For the Accommodation Admin, the primary view should include occupancy, available beds, reservations, arrivals/departures, approvals and operational exceptions. Reception should focus on today's transactions; maintenance should focus on jobs and SLA breaches; Security should focus on entry verification and active incidents.

## 15. Final implementation order

1. Foundation: Data model, site hierarchy, users, permissions, audit and workflow engine.
2. Accommodation core: Staff eligibility, individual beds, allocation, reservation, waitlist, check-in, transfers and checkout.
3. Operational services: Keys, assets, cleaning, maintenance, inventory and clearance.
4. Resident and safety workflows: Self-service, visitors, facilities, incidents, SOS and contractor access.
5. Governance and reporting: Dashboards, exports, integrations, scheduled reports, reconciliation and audit exploration.
6. End-to-end validation: Test every role, permission, status transition, concurrency case, exception and recovery path before client sign-off.

### Acceptance criteria before release

The system should not be considered ready until the following tests pass:

- Two simultaneous requests cannot reserve the same bed.
- Occupancy and vacancy totals reconcile at bed, room, building and site levels.
- No resident can access another resident's protected information.
- A denied or expired approval cannot execute its underlying operation.
- Checkout does not release a bed for allocation before readiness requirements are met.
- A failed transfer leaves a consistent, recoverable state.
- Maintenance and inventory movements reconcile with their work orders.
- Revoked contractor access is enforced and audited.
- Notifications and integrations recover from temporary failures without duplicate business operations.
- All privileged changes and exceptions are traceable in the audit log.

Final conclusion: The document provides a strong functional baseline, but the workable software journey depends on enforcing the relationships between people, stays, individual beds, approvals, operational tasks and audit events. Implement those as connected stateful workflows, and the platform will behave as a coherent accommodation management system rather than a collection of disconnected modules.