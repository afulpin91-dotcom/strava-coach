# Strava Coach — app iPhone (PWA)

Une app qui s'installe sur l'écran d'accueil de l'iPhone. **Vos données restent sur le téléphone**
(stockage local du navigateur). L'hébergement ne contient que le code, jamais vos activités ni vos clés.

Fichiers à publier (à plat, 13 fichiers) : `index.html`, `app.js`, `engine.js`, `db.js`, `strava.js`, `importer.js`, `coach.js`,
`sw.js`, `manifest.webmanifest` et les 4 images `*.png`.
`worker.js` et `inbox-worker.js` (scripts Cloudflare, facultatifs) ne sont pas servis par l'app : ils servent aux étapes 4 et « Synchro automatique ».

## 1. Publier l'app (une seule fois, ~10 min, gratuit)

1. Créez un compte sur github.com, puis un dépôt **public** nommé `strava-coach`.
2. Dans le dépôt : **Add file › Upload files**, sélectionnez les 13 fichiers, puis **Commit changes**.
   (Sur iPhone : dézippez d'abord l'archive dans l'app Fichiers.)
3. **Settings › Pages › Build and deployment** : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
   Au bout d'une ou deux minutes, l'adresse est `https://VOTRE-NOM.github.io/strava-coach/`.

## 2. Installer l'app sur l'iPhone

Ouvrez l'adresse de l'étape 1 dans **Safari** › Partager › **Sur l'écran d'accueil**, puis lancez l'app depuis l'icône.

## 3. Charger vos données (gratuit, sans l'API Strava)

Strava réserve son API aux abonnés ; l'export de vos données reste la voie gratuite.
1. Sur strava.com : Paramètres › Mon compte › « Télécharger ou supprimer votre compte » › demandez l'archive.
2. Téléchargez le ZIP reçu par e-mail.
3. Dans l'app : **Réglages › Importer mon export Strava**, choisissez le ZIP (ou des fichiers FIT / GPX / TCX).
   Un nouvel export plus tard n'ajoute que les nouveautés, sans doublons.

- Les fichiers **FIT** contiennent la fréquence cardiaque : zones précises. Les **GPX** n'en ont pas
  (distance, durée et dénivelé seulement).
- Strava n'indique pas dans les fichiers quelles activités sont des courses : touchez 🏁 sur une activité
  pour la marquer. Cela recalcule votre niveau et vos allures.
- Ensuite : créez votre objectif sur le tableau de bord.

## 4. (Option, abonnés Strava) Connexion directe à l'API

Réglages › « Connexion directe à Strava » : Client ID / Secret d'une application créée sur strava.com/settings/api
(« Authorization Callback Domain » = `VOTRE-NOM.github.io`), puis **Se connecter** ; si la page s'ouvre dans Safari,
copiez le code affiché et collez-le dans Réglages › Coller le code. Un bouton **Synchroniser** apparaît alors.
Si le test de connexion directe échoue (CORS), utilisez le relais Cloudflare :
1. dash.cloudflare.com › Workers & Pages › **Create** › Worker › collez `worker.js` › Deploy.
2. Settings › Variables : `CLIENT_ID`, `CLIENT_SECRET` (type *Secret*), `ALLOWED_ORIGIN` = `https://VOTRE-NOM.github.io`.
3. Réglages › « Adresse du relais » : l'adresse `https://….workers.dev`.

## Synchro automatique depuis Santé (boîte de réception)

**Principe.** Une app web ne peut pas lire Santé (HealthKit) : seul un raccourci iPhone le peut. Il dépose vos séances dans
**votre** petite boîte de réception Cloudflare (gratuite, protégée par un code secret) ; l'app les récupère toute seule à
l'ouverture, puis recalcule le plan. Les séances déjà connues (export Strava, saisie) ne sont jamais dupliquées.
Rien n'est envoyé ni reçu tant que l'adresse et le code ne sont pas renseignés dans Réglages.

### A. Créer la boîte (une fois, ~10 min)
1. dash.cloudflare.com › Workers & Pages › **KV** › Create : un espace nommé `inbox`.
2. Workers & Pages › Create › **Worker** (nom libre, ex. `ma-boite-sante`) › Deploy › Edit code : collez `inbox-worker.js` › Deploy.
3. Worker › Settings › Bindings › Add › **KV namespace** : nom de variable `INBOX`, espace `inbox`.
4. Settings › Variables and Secrets : `TOKEN` (type *Secret*, au moins 16 caractères aléatoires : c'est votre mot de passe)
   et `ALLOWED_ORIGIN` = `https://VOTRE-NOM.github.io` (l'adresse de l'app, sans `/` final).
5. Dans l'app : Réglages › **3. Synchro automatique** : collez l'adresse du Worker (`https://….workers.dev`) et le code › Enregistrer
   › **Récupérer maintenant** : « Rien de nouveau dans la boîte » signifie que la liaison fonctionne.

### B. Le raccourci iPhone (non testé par moi : les noms d'actions peuvent différer selon votre version d'iOS)
Dans l'app **Raccourcis**, créez un raccourci avec ces actions :
1. **Rechercher des échantillons de santé** : type *Séances d'entraînement* (Workouts), date de début **dans les 3 derniers jours**, trié par date, limite 20.
2. **Répéter avec chaque élément** : pour chaque séance, créez un **dictionnaire** avec :
   `type` (type de séance), `start` (date de début, format ISO 8601), `duration_s` (durée en secondes),
   `distance_m` (distance totale en mètres), et si possible `avg_hr` (FC moyenne : un second « Rechercher des échantillons de santé »
   de type *Fréquence cardiaque* entre le début et la fin de la séance, puis *Calculer des statistiques › Moyenne*).
   Ajoutez ce dictionnaire à une liste.
3. **Obtenir le contenu de l'URL** : `https://VOTRE-WORKER.workers.dev/ingest`, méthode **POST**, en-tête
   `Authorization` = `Bearer VOTRE-CODE`, corps de la requête **JSON** : un champ `workouts` = la liste.
4. Lancez-le à la main une fois (iOS demande l'accès à Santé), puis, dans l'app : **Récupérer maintenant**.

Format attendu (les nombres en texte, la virgule décimale, `duration_min`, `distance_km` et `end` sont aussi acceptés) :
```json
{"workouts":[{"type":"Running","start":"2026-10-18T07:30:00Z","duration_s":3300,"distance_m":9800,"avg_hr":151}]}
```
Test sans iPhone : `curl -X POST https://VOTRE-WORKER.workers.dev/ingest -H "Authorization: Bearer VOTRE-CODE" -H "Content-Type: application/json" -d '{"workouts":[...]}'`

### C. L'automatiser
Raccourcis › **Automatisation** › + › choisissez un déclencheur › exécuter ce raccourci › désactivez « Demander avant d'exécuter ».
**Attention :** les données Santé sont chiffrées quand l'iPhone est verrouillé ; un déclencheur « heure de la journée » la nuit peut
donc ne rien lire. Préférez un déclencheur qui arrive quand vous utilisez le téléphone (par exemple l'ouverture d'une appli que
vous ouvrez après chaque sortie), ou lancez le raccourci depuis l'écran d'accueil. À vérifier sur votre téléphone.

## Utiliser le plan

- **Vos jours :** à la création de l'objectif, cochez les jours où vous pouvez courir (3 à 6) et le jour de la sortie longue.
  Les séances dures sont placées loin de la sortie longue et jamais collées l'une à l'autre.
- **Déplacer une séance :** touchez ⇄ à côté de la séance et choisissez un autre jour de la même semaine
  (échange si le jour est pris). Le déplacement est conservé quand le plan se recalcule.
- **Suivi :** une séance faite un autre jour de la semaine compte (✓ « faite le … ») ; ⏳ = pas encore faite cette
  semaine ; ✗ n'apparaît qu'une fois la semaine terminée.
- **Pause (blessure, maladie) :** « Mettre en pause » retire les séances à venir ; à la reprise, le volume repart plus bas
  selon la durée de l'arrêt (−15 %, −30 % ou −45 %), sans rattrapage.
- **Niveau :** sans course, l'app l'estime depuis l'allure et la FC de vos sorties (il faut donc une FC max et une FC repos
  justes dans Réglages). « Affiner mon niveau » permet d'ajouter une course ou un test en quelques secondes.

## Plan de course (allure par km)

Sur le plan, ouvrez **🏁 Plan de course** : l'allure à viser à chaque kilomètre pour tenir votre temps visé (le total fait exactement ce temps),
avec les temps de passage tous les 5 km, la possibilité de **copier** ou **partager** le tableau. Trois stratégies : *progressif* (départ ~2 % plus lent,
arrivée ~2 % plus rapide, recommandé), *régulier*, *très prudent*. Option : chargez le **GPX du parcours** (avec altitude) pour ajuster
l'allure aux côtes (à effort égal : ordre de grandeur, +5 % de pente ≈ +18 % de temps) ; la pente de chaque km est affichée.

## Le coach (IA) : relire sa réponse dans l'app

1. **① Générer le message** : il contient vos chiffres, votre plan, votre état du jour et les remarques déjà reçues.
   Collez-le dans une IA (Claude, ChatGPT…).
2. **② Collez sa réponse complète** dans l'app, puis **Lire la réponse**. L'app extrait le bloc de séances,
   le contrôle (jours choisis, volume raisonnable, 3 séances dures maximum, pas de séance dure la veille de la course,
   pas de séance en pause) et vous montre un aperçu : séances retenues, refusées et pourquoi.
3. **Appliquer** remplace les séances automatiques sur ces jours. Suivi, déplacement et pause fonctionnent dessus ;
   🧠 repère les séances du coach, et « Revenir au plan automatique » annule tout.
4. Les remarques du coach (douleur, préférence…) sont gardées en mémoire et renvoyées dans vos prochains messages.

Rien n'est appliqué sans votre validation, et une réponse mal formée est refusée avec un message.

## À savoir

- Limite de l'API (abonnés) : 100 requêtes par 15 min ; un premier import long peut s'interrompre (progression sauvegardée).
- Faites de temps en temps **Réglages › Exporter une sauvegarde** (fichier JSON, sans le secret).
  iOS peut vider les données d'un site peu utilisé ; une app installée est normalement épargnée.
- Mise à jour du code : modifiez `CACHE = 'strava-coach-v11'` dans `sw.js` (v2, v3…) pour forcer le rafraîchissement.
- Le moteur est vérifié identique à la version Python : `node tests/compare.mjs` (après `python3 tests/gen_reference.py`).
- Ce n'est pas un avis médical : en cas de douleur ou de fatigue anormale, levez le pied.
