**BRICX IQ **

** PROJECT DESCRIPTION AND CONSTRAINTS**

**1. Project Description**

BRICX IQ is a global, mobile-first and web-based Construction Site Management and Project Control Platform designed to serve the worldwide construction industry.

The system functions as a centralized **Construction Command Center**, bringing construction project activities into one connected platform. It manages the complete project lifecycle, from pre-construction and estimating through construction, financial management, monitoring, quality and safety, to project handover.

BRICX IQ connects **Project Owners, Project Managers, Site Managers, Engineers, Quantity Surveyors, Procurement Teams, Store Controllers, Supervisors, Workers, Subcontractors, Consultants and Clients** within one secure environment.

The platform will manage:

- Construction projects and multiple sites

- Tasks, milestones and project progress

- Daily site logs and field reports

- Workers, attendance and timesheets

- Materials, inventory and equipment

- Procurement and purchase requests

- Estimating and Bill of Quantities (BOQ)

- Budgets, expenditures and financial tracking

- Mobile Money, bank and supported payment services

- Invoices, receipts and petty cash

- Change Orders and variations

- Project documents and drawings

- RFIs, Submittals and Punch/Snag Lists

- Quality inspections and safety management

- Project communication and internal messaging

- Client and Project Owner portals

- Dashboards, analytics and reporting

- BIM/IFC model integration

- Project handover and closeout management

A major objective of BRICX IQ is to provide complete visibility and accountability throughout a construction project. Every important activity can be connected to the responsible person, project, task, document, cost code, transaction or site location.

For example:

**Material Request → Approval → Payment → Receipt → Delivery → Site Verification → Daily Log → Cost Record → Project Dashboard**

This creates a complete digital record of what happened, who performed or approved it, when it happened and how it affected the project.

The platform is designed for the **global construction market**, meaning it must be capable of operating across different countries, currencies, languages, regulations, payment systems, operating systems and device types.

**2. Project Constraints and Requirements**

**2.1 Global Market Requirement**

BRICX IQ must be designed for the **worldwide construction market** and must not be restricted to Sierra Leone, Africa or any single geographical region.

The architecture must support different countries and allow regional configurations for:

- Currency

- Language

- Time zone

- Date and number formats

- Payment providers

- Accounting systems

- Local integrations

- Regulatory and compliance requirements

The core application must remain consistent while allowing country-specific functionality to be added when required.

**2.2 Multi-Currency Requirement**

The system must support multiple currencies because projects may operate in different countries or use more than one currency.

BRICX IQ must:

- Automatically identify or allow configuration of the project's operating currency.

- Display financial information using the appropriate local/project currency.

- Support transactions in different currencies.

- Convert currencies when required.

- Store the original transaction amount and original currency.

- Store the exchange rate used for conversion.

- Store the converted/reporting amount.

- Maintain an exchange-rate history for financial auditing.

- Allow the Project Owner to manually override the default currency when necessary.

- Support appropriate currency symbols, decimal rules and number formatting.

Example:

**Material Cost: USD 5,000**

Project reporting currency:

**SLE**

The system records the original USD transaction while also calculating and displaying its equivalent value in the project's reporting currency.

**2.3 Multi-Language Requirement**

BRICX IQ must support users from different countries and language backgrounds.

The system must:

- Detect the user's device or configured location/language where appropriate.

- Automatically select an initial interface language.

- Allow users to manually change their preferred language.

- Support multiple languages throughout the application.

- Translate menus, buttons, notifications, reports and field workflows.

- Maintain consistent construction terminology across languages.

- Allow new languages to be added without rebuilding the entire system.

- Support project-specific language preferences for international teams.

Language selection must therefore be treated as a core platform capability rather than a cosmetic feature.

**2.4 Cross-Platform Requirement**

BRICX IQ must work across major operating systems and device types.

The platform should support:

- Windows

- macOS

- Linux

- Android

- iOS

- Desktop computers

- Laptops

- Tablets

- Smartphones

- Supported modern web browsers

The system should provide a consistent user experience while adapting the interface to the device being used.

For example:

**Desktop/Laptop:**
Advanced project management, financial control, reporting, document management and portfolio dashboards.

**Tablet:**
Site supervision, drawings, inspections, daily logs and project management.

**Mobile:**
Photos, attendance, approvals, messages, receipts, quick updates and offline field activities.

All platforms must connect to the same central backend, database, authentication system, permissions and project data.

**2.5 Offline Operation Constraint**

Construction sites may have poor or unstable internet connectivity.

Therefore, important field functions must continue working when the device is offline.

The application should allow users to:

**Capture Data → Store Locally → Reconnect → Synchronize → Resolve Conflicts**

Offline functionality should include relevant activities such as:

- Daily logs

- Photos

- Tasks

- Inspections

- Punch lists

- Attendance

- Site updates

- Selected drawings/models

The synchronization system must detect and resolve conflicting changes without unnecessarily losing user data.

**2.6 Security and Owner-Control Constraint**

The Project Owner must retain ultimate control over the platform.

The system must provide:

- Role-Based Access Control (RBAC)

- Custom permissions

- Approval hierarchies

- Temporary elevated access

- Immediate access revocation

- Secure authentication

- Session management

- Audit logs

- Data access controls

- Financial authorization controls

Every important action should record:

**Who → What → When → Where/Device**

No ordinary user should be able to bypass the permissions or approval structure established by the Project Owner.

**2.7 Financial Security Constraint**

Because BRICX IQ can manage real project money, financial functionality must be treated as a high-security component.

Financial activities must support:

- Approval workflows

- Spending limits

- Transaction history

- Supporting receipts/documents

- Cost-code association

- Payment verification

- Change-order approvals

- Petty cash controls

- Milestone payment verification

- Exchange-rate records

- Financial audit trails

The system must distinguish between **requested, approved, paid, received and recorded** financial activities.

**2.8 Payment Integration Constraint**

BRICX IQ should support different payment systems depending on the country in which it operates.

The payment architecture must therefore be extensible rather than hard-coded to one provider.

Possible integrations can include:

- Mobile Money

- Bank transfers

- Payment gateways

- Remittance services

- Local payment networks

The system should record payment confirmations and automatically associate them with the appropriate project, cost code, expenditure record and supporting documents.

**2.9 Role and Permission Constraint**

Different users must have different levels of access.

Typical roles include:

- Project Owner

- Super Admin

- Project Manager

- Site Manager

- Quantity Surveyor

- Cost Controller

- Site Supervisor

- Foreman

- Procurement Officer

- Store Controller

- Engineer

- Subcontractor

- Client

- Consultant

- Administrator

Permissions must be configurable and should follow the user's responsibilities.

**2.10 BIM Constraint**

BIM/IFC functionality should be introduced progressively.

The core construction management system must **not depend on BIM for its basic operation**.

The planned approach is:

**Phase 1:**
2D drawings, markups and basic IFC viewing.

**Phase 2:**
Model properties, measurements, section views and connections between model elements and project activities.

**Phase 3:**
Federated models, model comparison, quantity extraction and advanced BIM functionality.

This allows BRICX IQ to provide strong construction management capabilities before introducing more complex BIM functionality.

**2.11 Localization Constraint**

BRICX IQ must separate its core business logic from country-specific settings.

The system should have configurable:

- Country

- Region

- Currency

- Language

- Time zone

- Date format

- Number format

- Measurement units

- Payment providers

- Accounting integrations

- Local rate libraries

This ensures that the platform can expand internationally without redesigning the entire system for every new country.

**2.12 Data and Audit Constraint**

Important project information must remain traceable.

The system should maintain permanent records for:

- Financial transactions

- Approvals

- User actions

- Document changes

- Project updates

- Payments

- Change Orders

- RFIs

- Site activities

- Inventory movements

Records should include appropriate timestamps, users and supporting evidence.

**3. Overall Project Objective**

The main objective of BRICX IQ is to create a **globally accessible, secure and scalable construction management platform** that brings the entire construction project lifecycle into one connected digital environment.

The platform must provide:

**Global Access + ****Multi-Currency**** + ****Multi-Language**** + Cross-Platform Support + Offline Capability + Financial Control + Construction Management + Strong Security + Complete Accountability.**

BRICX IQ should ultimately allow a construction company or Project Owner to manage projects from anywhere in the world while allowing workers and site teams to operate effectively from the field using the devices and connectivity available to them.