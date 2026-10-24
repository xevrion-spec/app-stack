# Loops transactional templates (drafts only — nothing is sent from this repo)
Create these in Loops > Transactional and paste the IDs into Worker secrets. Footer on every email:
"Xevrion is a trading name of Henry Davenhall, sole trader, United Kingdom."

| id (suggested) | Trigger | Variables |
|---|---|---|
| `job-complete` | Job delivered | firstName, period, qaScore, reviewUrl |
| `review-needed` | Exceptions need the customer's input | firstName, count, reviewUrl |
| `vat-draft-ready` | Draft VAT summary ready to approve | firstName, period, net, approveUrl |
| `welcome` | Sign-up | firstName |
