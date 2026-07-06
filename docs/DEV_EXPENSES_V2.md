# Dev Expenses Tracker v3 — Devis, Archivage & Cycle complet

> **Évolution de la v2** : ajout des devis (estimations en amont de la facturation),
> archivage soft des dépenses payées, et vue « À payer » segmentée en 3 groupes.
>
> **Cycle complet** : Devis → Acceptation → Dev Expense (pending) → Paiement → Archive
>
> Financé par tekkbridge, réglé par Benoît au nom de tekkbridge.

---

## Architecture

### Tables Supabase

#### `creditors` (nouvelle, migration `20260706120000`)

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | uuid PK | Auto-généré |
| `name` | text | Nom du créancier (Render, Jean Dupont…) |
| `entity_type` | text | `cloud_provider` \| `freelance` \| `company` \| `individual` \| `other` |
| `contact_email` | text? | Email de contact |
| `payment_method` | text? | `bank_transfer` \| `mobile_money` \| `crypto` \| `other` |
| `payment_details` | jsonb? | IBAN, wallet, numéro — structure libre |
| `default_category` | text? | Suggestion auto-remplissage catégorie |
| `notes` | text? | Notes libres |
| `active` | bool | Soft-delete : `false` = désactivé |
| `created_at` | timestamptz | — |

#### `dev_expenses` (évolué, migrations `20260706120000` + `20260706150000`)

Colonnes ajoutées / modifiées :

| Changement | Détail |
|-----------|--------|
| `service` → `category` | Renommé + catégorie libre (initcap) |
| `UNIQUE(service, billing_month)` | **Supprimé** |
| CHECK sur `service` | **Supprimé** |
| `creditor_id` | FK → `creditors.id` |
| `project_ref` | max 200 chars, référence projet/site |
| `due_date` | DATE, date d'échéance |
| `invoice_number` | max 100 chars |
| `funded_by` | default `'tekkbridge'` |
| `paid_by` | default `'benoit'` |
| `archived` | boolean NOT NULL default false (v3) |
| `archived_at` | timestamptz, NULL quand non archivé (v3) |

**Index v3** : `idx_dev_expenses_active_due` sur `(status, due_date) WHERE archived = false`

#### `quotes` (nouvelle, migration `20260706150000`)

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | uuid PK | Auto-généré |
| `creditor_id` | uuid? | FK → `creditors.id` (ON DELETE SET NULL) |
| `creditor_name` | text? | Saisie libre si creditor_id NULL |
| `project_ref` | text NOT NULL | Référence projet |
| `category` | text? | Catégorie libre |
| `amount_usd` | numeric(10,2) | Montant estimé, CHECK ≥ 0 |
| `description` | text? | Description libre |
| `status` | text | `draft` \| `sent` \| `accepted` \| `rejected` \| `expired` |
| `valid_until` | date? | Date de validité du devis |
| `quote_file_url` | text? | Chemin dans le bucket `dev-expenses-invoices/quotes/` |
| `converted_expense_id` | uuid? | FK → `dev_expenses.id` — renseigné quand accepté |
| `notes` | text? | Notes libres |
| `created_at` | timestamptz | — |
| `updated_at` | timestamptz | — |

**RLS** : `service_role` only (même politique que `dev_expenses`).

**Index partiel** : `dev_expenses_creditor_month_auto_uq` sur `(creditor_id, billing_month) WHERE source='api_pull'`  
→ Permet plusieurs entrées manuelles par créancier/mois, une seule entrée API.

#### Vue `dev_expenses_with_status`

Enrichit chaque ligne avec :
- `is_overdue` (bool dynamique : `due_date < today AND status != 'paid'`)
- `creditor_name`, `creditor_entity_type`, `creditor_payment_method`, `creditor_payment_details`

---

## API Endpoints

### Creditors `/v1/admin/creditors`

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/v1/admin/creditors` | Créer un créancier |
| `GET` | `/v1/admin/creditors?active=true&entity_type=` | Lister |
| `PATCH` | `/v1/admin/creditors/:id` | Mettre à jour |
| `DELETE` | `/v1/admin/creditors/:id` | Soft-delete (`active=false`) |

### Dev Expenses `/v1/admin/dev-expenses`

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/pull-automated` | Pull Anthropic + Vercel (cron mensuel) |
| `POST` | `/` | Saisie manuelle multipart (creditor_id/name, project_ref, due_date, invoice_number) |
| `PATCH` | `/:id/mark-paid` | Marquer payé + payment_ref |
| `PATCH` | `/:id/archive` | Archiver (uniquement si status=paid, sinon 400) |
| `PATCH` | `/:id/unarchive` | Désarchiver |
| `POST` | `/generate-report` | PDF + share_token. **Exclut archived=true**. Agrège par billing_month ET due_date |
| `GET` | `/?billing_month=&status=&creditor_id=&overdue=&archived=` | Lister factures. `archived=true` → vue archives. Défaut : non-archivées |
| `GET` | `/upcoming` | **3 groupes** : `{ overdue, pending, paid_recent }`. Exclut archived |
| `GET` | `/history?page=&limit=` | Historique mensuel (exclut archived) |
| `GET` | `/dev-expenses/report/:token` | **PUBLIC** — rapport JSON tokenisé (exclut archived) |

### Quotes `/v1/admin/quotes`

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/` | Créer un devis (multipart : fichier PDF optionnel) |
| `GET` | `/?status=&creditor_id=` | Lister les devis (filtrable par statut/créancier) |
| `PATCH` | `/:id` | Éditer (montant, statut, validité, notes). Refusé si déjà accepted |
| `POST` | `/:id/accept` | Accepter → crée automatiquement une `dev_expense` (status=pending, source=quote). Body: `{ due_date, billing_month?, invoice_number? }` |
| `POST` | `/:id/reject` | Rejeter → status=rejected |

---

## Crons Render

| Nom | Schedule | Script | Description |
|-----|----------|--------|-------------|
| `dev-expenses-monthly-pull` | `0 6 1 * *` | `cron-pull-dev-expenses.js` | Pull API Anthropic + Vercel le 1er du mois |
| `dev-expenses-due-check` | `0 8 * * *` | `cron-due-date-check.js` | Check factures dues dans 7j, log urgence J+3 |

---

## Frontend Admin (unipay-congo)

Page `/dashboard/admin/dev-expenses` — 6 onglets :

| Onglet | Contenu |
|--------|---------|
| **À payer** | 3 sections empilées : En retard (rouge), À venir (orange, J+7), Payées récemment (vert, collapsible). Bouton « Archiver » sur chaque ligne payée |
| **Saisie** | Formulaire enrichi : sélecteur créancier (+ création à la volée), catégorie libre, projet, échéance, N° facture, upload |
| **Créanciers** | CRUD : liste, ajout, édition coordonnées paiement, soft-delete |
| **Devis** | Liste avec badge statut (brouillon/envoyé/accepté/rejeté/expiré). Création avec upload PDF. Boutons Accepter (mini-form due_date → crée dépense) / Rejeter. Auto-expiration si valid_until dépassé |
| **Rapports** | Génération PDF + lien public, historique mensuel (exclut archived) |
| **Archives** | Dépenses archivées, recherche par créancier/projet/mois, bouton « Désarchiver » |

---

## Page publique (Netlify)

URL : `https://dev-expenses.netlify.app/report/:token`

Affiche par facture : créancier, catégorie, projet, date d'échéance, montant, statut.  
Sections de synthèse : **Par créancier** + **Par catégorie** (si > 1 entrée).

---

## Règles métier

- **Cycle devis → dépense** : un devis `sent` peut être accepté (POST `/quotes/:id/accept`) → crée une `dev_expense` (status=pending, source=quote) et lie `converted_expense_id`. Le devis ne peut plus être modifié après acceptation.
- **Archivage** : soft-archive (`archived=true`, `archived_at=now()`). Uniquement sur dépenses `status=paid` (400 si pending). Exclu des rapports PDF, de la vue upcoming, et de l'historique. Désarchivable.
- **Génération rapport** : agrège toutes les factures dont `billing_month` ou `due_date` tombe dans le mois. **Exclut archived=true et les devis** (devis ≠ dépense engagée). Factures `pending` → `pending_warnings` (non bloquant).
- **Soft-delete créancier** : `DELETE /creditors/:id` met `active=false`, jamais de vraie suppression.
- **Pull automatisé** : crée/récupère le créancier Anthropic/Vercel par nom (`ilike`), puis SELECT+UPDATE/INSERT.
- **Devis expirés** : calcul à l'affichage (frontend) — si `status=sent` et `valid_until < today`, traité comme `expired`.
- **Storage** : bucket `dev-expenses-invoices`, sous-dossier `quotes/` pour les devis. MIME whitelist : PDF/PNG/JPEG, max 10 Mo.
- `funded_by = 'tekkbridge'`, `paid_by = 'benoit'` — valeurs par défaut, éditables.
- **Jamais de DELETE réel** sur `dev_expenses` ni `quotes` — archivage et soft-delete uniquement.
