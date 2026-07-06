# Dev Expenses Tracker v2 — Generalised Creditor/Invoice Registry

> **Évolution de la v1** (5 cloud services fixes) vers un registre créanciers/factures
> généraliste : tout type de créancier, catégorie libre, référence projet, date d'échéance.
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

#### `dev_expenses` (évolué, migration `20260706120000`)

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
| `POST` | `/` | Saisie manuelle multipart (nouveau : creditor_id/name, project_ref, due_date, invoice_number) |
| `PATCH` | `/:id/mark-paid` | Marquer payé + payment_ref |
| `POST` | `/generate-report` | PDF + share_token. Ne bloque plus sur services manquants. Agrège par billing_month ET due_date. Retourne `pending_warnings` |
| `GET` | `/?billing_month=&status=&creditor_id=&overdue=true` | Lister factures (filtres étendus) |
| `GET` | `/upcoming` | Factures dues dans 7 jours, status=pending |
| `GET` | `/history?page=&limit=` | Historique mensuel (invoice_count, creditor_count) |
| `GET` | `/dev-expenses/report/:token` | **PUBLIC** — rapport JSON tokenisé |

---

## Crons Render

| Nom | Schedule | Script | Description |
|-----|----------|--------|-------------|
| `dev-expenses-monthly-pull` | `0 6 1 * *` | `cron-pull-dev-expenses.js` | Pull API Anthropic + Vercel le 1er du mois |
| `dev-expenses-due-check` | `0 8 * * *` | `cron-due-date-check.js` | Check factures dues dans 7j, log urgence J+3 |

---

## Frontend Admin (unipay-congo)

Page `/dashboard/admin/dev-expenses` — 4 onglets :

| Onglet | Contenu |
|--------|---------|
| **À payer** | Factures échues (rouge = overdue, orange = J+3, jaune = J+7). Bouton "Réglé" inline |
| **Saisie** | Formulaire enrichi : sélecteur créancier (+ création à la volée), catégorie libre (suggestions), projet, échéance, N° facture, upload |
| **Créanciers** | CRUD : liste, ajout, édition coordonnées paiement, soft-delete |
| **Rapports** | Génération PDF + lien public, historique mensuel (N factures, M créanciers) |

---

## Page publique (Netlify)

URL : `https://dev-expenses.netlify.app/report/:token`

Affiche par facture : créancier, catégorie, projet, date d'échéance, montant, statut.  
Sections de synthèse : **Par créancier** + **Par catégorie** (si > 1 entrée).

---

## Règles métier

- **Génération rapport** : n'est plus bloquée par l'absence de services — agrège toutes les factures dont `billing_month` ou `due_date` tombe dans le mois. Factures `pending` → `pending_warnings` dans la réponse (non bloquant).
- **Soft-delete créancier** : `DELETE /creditors/:id` met `active=false`, jamais de vraie suppression si des `dev_expenses` y sont liées.
- **Pull automatisé** : crée/récupère le créancier Anthropic/Vercel par nom (`ilike`), puis SELECT+UPDATE/INSERT (pas d'upsert sur contrainte partielle).
- `funded_by = 'tekkbridge'`, `paid_by = 'benoit'` — valeurs par défaut, éditables.
