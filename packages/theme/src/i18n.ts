// Languages a deployment can run in, and every piece of text the widget shows in each.
// Shared by the console (language pickers, the answer-language rule) and the widget, which
// picks its text at runtime so "auto" can follow the page it's on.
//
// Each language keeps one register throughout: informal in Spanish and Italian ("tú", "tu"),
// formal in French, German and Dutch ("vous", "Sie", "u"), and "você" in Portuguese.

export const LANGUAGES = [
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "it", name: "Italian", native: "Italiano" },
] as const;
export type Language = (typeof LANGUAGES)[number]["code"];
// A deployment's setting: one language, or "auto" to follow each visitor's browser.
export type LanguageSetting = Language | "auto";

export const isLanguage = (value: unknown): value is Language => LANGUAGES.some((l) => l.code === value);

export const languageSetting = (value: unknown): LanguageSetting => (value === "auto" || isLanguage(value) ? value : "en");

export const languageName = (code: Language): string => LANGUAGES.find((l) => l.code === code)?.name ?? code;

// The language a tag like "es-MX" or "PT_br" names, if the widget has text for it.
export const languageOf = (tag: unknown): Language | undefined => {
  const primary = typeof tag === "string" ? tag.trim().split(/[-_]/)[0]?.toLowerCase() : undefined;
  return isLanguage(primary) ? primary : undefined;
};

// "auto" takes the first preferred language the widget has text for: the widget passes the
// snippet's data-language, then <html lang>, then the browser's languages (pageLanguages).
// `served` narrows that to the languages the deployment has copy for; the first of them, the
// language its main copy is written in, catches every other visitor.
export function resolveLanguage(setting: unknown, preferred: readonly string[] = [], served: readonly Language[] = []): Language {
  if (isLanguage(setting)) return setting;
  if (setting === "auto") {
    for (const tag of preferred) {
      const language = languageOf(tag);
      if (language && (!served.length || served.includes(language))) return language;
    }
    if (served[0]) return served[0];
  }
  return "en";
}

// What "auto" consults, most specific first: the embed snippet's data-language, the page's
// <html lang>, then the visitor's browser.
export const pageLanguages = (snippet: string | null | undefined, page: string | null | undefined, browser: readonly string[]): string[] =>
  [snippet, page, ...browser].filter((tag): tag is string => Boolean(tag?.trim()));

export interface WidgetStrings {
  // Header and launcher name when the deployment has no nickname.
  title: string;
  open: string;
  close: string;
  closeChat: string;
  ask: string;
  send: string;
  question: string;
  noAnswer: string;
  failed: string;
  // Instead of failed while the site's domain is allowed but Agentic RAG hasn't applied it yet.
  almostReady: string;
  sources: string;
  poweredBy: string;
  // Defaults for the copy a partner can override per deployment.
  welcome: string;
  placeholder: string;
  disclosure: string;
  offline: string;
  // Handoff to a person: the header button, the link under answers, the card's intro, and
  // default labels for contact links the partner left unlabelled.
  talkToPerson: string;
  stillNeedHelp: string;
  handoff: string;
  contactPage: string;
  callUs: string;
  emailUs: string;
  // A price reply that contradicted the confirmed price table, replaced with its rows: the intro,
  // and each row's billing period.
  prices: string;
  // A price the safeguard can't state: the pricing page, linked by the reply's button.
  pricesOnPage: string;
  // After 1.5 s of a held price reply, with the screen reader told once (build 8).
  checkingPrices: string;
  perMonth: string;
  perYear: string;
  // A failed reply's button, which asks the same question again.
  retry: string;
  // Thumbs under an answer.
  helpful: string;
  notHelpful: string;
  feedbackThanks: string;
  // The link in the AI disclosure line, when the deployment has a privacy notice.
  privacy: string;
  // The in-chat contact form.
  leadButton: string;
  leadIntro: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  optional: string;
  consent: string;
  includeConversation: string;
  cancel: string;
  leadSent: string;
  leadFailed: string;
  fieldRequired: string;
  emailInvalid: string;
  phoneInvalid: string;
  consentRequired: string;
}

// English is the one language inside the widget's bundle; the others reach it through the public
// config (configStrings), so a site downloads only the languages its chat can use.
export const englishStrings: WidgetStrings = {
  title: "Ask us",
  open: "Open",
  close: "Close",
  closeChat: "Close chat",
  ask: "Ask",
  send: "Send",
  question: "Your question",
  noAnswer: "Sorry, I couldn't find an answer to that on this site.",
  failed: "Something went wrong. Please try again.",
  almostReady: "Almost ready: this chat is still being switched on for this site. Please try again in a minute.",
  sources: "Sources",
  poweredBy: "Powered by Progress® Agentic RAG",
  welcome: "Hi! Ask me anything about this site.",
  placeholder: "Ask a question…",
  disclosure: "Answers are generated by AI from this site's content and may contain mistakes.",
  offline: "Chat is unavailable right now.",
  talkToPerson: "Talk to a person",
  stillNeedHelp: "Still need help?",
  prices: "The prices on our pricing page:",
  pricesOnPage: "Please see our pricing page for this price.",
  checkingPrices: "Checking our prices…",
  perMonth: "per month",
  perYear: "per year",
  handoff: "Our team can help:",
  contactPage: "Contact us",
  callUs: "Call us",
  emailUs: "Email us",
  retry: "Try again",
  helpful: "Helpful",
  notHelpful: "Not helpful",
  feedbackThanks: "Thanks for your feedback.",
  privacy: "Privacy notice",
  leadButton: "Send us a message",
  leadIntro: "Leave your details and our team will get back to you.",
  name: "Name",
  email: "Email",
  phone: "Phone",
  message: "Message",
  optional: "optional",
  consent: "I agree to be contacted about my request.",
  includeConversation: "Include this conversation",
  cancel: "Cancel",
  leadSent: "Thanks! Our team will be in touch.",
  leadFailed: "Your message couldn't be sent. Please try again.",
  fieldRequired: "Fill in this field.",
  emailInvalid: "Enter an email address like name@example.com.",
  phoneInvalid: "Enter a phone number.",
  consentRequired: "Tick this box to send your details.",
};

const STRINGS: Record<Language, WidgetStrings> = {
  en: englishStrings,
  es: {
    title: "Pregúntanos",
    open: "Abrir",
    close: "Cerrar",
    closeChat: "Cerrar chat",
    ask: "Preguntar",
    send: "Enviar",
    question: "Tu pregunta",
    noAnswer: "Lo siento, no encontré una respuesta a eso en este sitio.",
    failed: "Algo salió mal. Inténtalo de nuevo.",
    almostReady: "Casi listo: este chat aún se está activando en este sitio. Inténtalo de nuevo en un minuto.",
    sources: "Fuentes",
    poweredBy: "Con la tecnología de Progress® Agentic RAG",
    welcome: "¡Hola! Pregúntame lo que quieras sobre este sitio.",
    placeholder: "Haz una pregunta…",
    disclosure: "Las respuestas las genera una IA a partir del contenido de este sitio y pueden contener errores.",
    offline: "El chat no está disponible en este momento.",
    talkToPerson: "Hablar con una persona",
    stillNeedHelp: "¿Necesitas más ayuda?",
    prices: "Los precios de nuestra página de precios:",
    pricesOnPage: "Consulte este precio en nuestra página de precios.",
    checkingPrices: "Comprobando nuestros precios…",
    perMonth: "al mes",
    perYear: "al año",
    handoff: "Nuestro equipo puede ayudarte:",
    contactPage: "Contáctanos",
    callUs: "Llámanos",
    emailUs: "Escríbenos",
    retry: "Intentar de nuevo",
    helpful: "Útil",
    notHelpful: "No es útil",
    feedbackThanks: "¡Gracias por tu opinión!",
    privacy: "Aviso de privacidad",
    leadButton: "Envíanos un mensaje",
    leadIntro: "Déjanos tus datos y nuestro equipo te responderá.",
    name: "Nombre",
    email: "Correo electrónico",
    phone: "Teléfono",
    message: "Mensaje",
    optional: "opcional",
    consent: "Acepto que se pongan en contacto conmigo sobre mi solicitud.",
    includeConversation: "Incluir esta conversación",
    cancel: "Cancelar",
    leadSent: "¡Gracias! Nuestro equipo se pondrá en contacto contigo.",
    leadFailed: "No se pudo enviar tu mensaje. Inténtalo de nuevo.",
    fieldRequired: "Completa este campo.",
    emailInvalid: "Escribe un correo como nombre@ejemplo.com.",
    phoneInvalid: "Escribe un número de teléfono.",
    consentRequired: "Marca esta casilla para enviar tus datos.",
  },
  fr: {
    title: "Une question ?",
    open: "Ouvrir",
    close: "Fermer",
    closeChat: "Fermer le chat",
    ask: "Demander",
    send: "Envoyer",
    question: "Votre question",
    noAnswer: "Désolé, je n'ai pas trouvé de réponse à cette question sur ce site.",
    failed: "Une erreur s'est produite. Veuillez réessayer.",
    almostReady: "Presque prêt : ce chat est en cours d'activation sur ce site. Veuillez réessayer dans une minute.",
    sources: "Sources",
    poweredBy: "Propulsé par Progress® Agentic RAG",
    welcome: "Bonjour ! Posez-moi vos questions sur ce site.",
    placeholder: "Posez une question…",
    disclosure: "Les réponses sont générées par une IA à partir du contenu de ce site et peuvent contenir des erreurs.",
    offline: "Le chat n'est pas disponible pour le moment.",
    talkToPerson: "Parler à quelqu'un",
    stillNeedHelp: "Besoin d'aide supplémentaire ?",
    prices: "Les prix de notre page de tarifs :",
    pricesOnPage: "Veuillez consulter ce prix sur notre page de tarifs.",
    checkingPrices: "Vérification de nos prix…",
    perMonth: "par mois",
    perYear: "par an",
    handoff: "Notre équipe peut vous aider :",
    contactPage: "Nous contacter",
    callUs: "Nous appeler",
    emailUs: "Nous écrire",
    retry: "Réessayer",
    helpful: "Utile",
    notHelpful: "Pas utile",
    feedbackThanks: "Merci pour votre avis.",
    privacy: "Politique de confidentialité",
    leadButton: "Nous envoyer un message",
    leadIntro: "Laissez vos coordonnées et notre équipe vous recontactera.",
    name: "Nom",
    email: "E-mail",
    phone: "Téléphone",
    message: "Message",
    optional: "facultatif",
    consent: "J'accepte d'être recontacté au sujet de ma demande.",
    includeConversation: "Joindre cette conversation",
    cancel: "Annuler",
    leadSent: "Merci ! Notre équipe vous recontactera.",
    leadFailed: "Votre message n'a pas pu être envoyé. Veuillez réessayer.",
    fieldRequired: "Veuillez remplir ce champ.",
    emailInvalid: "Saisissez une adresse e-mail comme nom@exemple.fr.",
    phoneInvalid: "Saisissez un numéro de téléphone.",
    consentRequired: "Cochez cette case pour envoyer vos coordonnées.",
  },
  de: {
    title: "Fragen Sie uns",
    open: "Öffnen",
    close: "Schließen",
    closeChat: "Chat schließen",
    ask: "Fragen",
    send: "Senden",
    question: "Ihre Frage",
    noAnswer: "Leider habe ich auf dieser Website keine Antwort darauf gefunden.",
    failed: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
    almostReady: "Fast fertig: Dieser Chat wird gerade für diese Website eingerichtet. Bitte versuchen Sie es in einer Minute erneut.",
    sources: "Quellen",
    poweredBy: "Bereitgestellt von Progress® Agentic RAG",
    welcome: "Hallo! Fragen Sie mich alles zu dieser Website.",
    placeholder: "Stellen Sie eine Frage…",
    disclosure: "Die Antworten werden von einer KI aus den Inhalten dieser Website erstellt und können Fehler enthalten.",
    offline: "Der Chat ist derzeit nicht verfügbar.",
    talkToPerson: "Mit einer Person sprechen",
    stillNeedHelp: "Brauchen Sie weitere Hilfe?",
    prices: "Die Preise auf unserer Preisseite:",
    pricesOnPage: "Diesen Preis finden Sie auf unserer Preisseite.",
    checkingPrices: "Wir prüfen unsere Preise…",
    perMonth: "pro Monat",
    perYear: "pro Jahr",
    handoff: "Unser Team hilft Ihnen gerne:",
    contactPage: "Kontakt",
    callUs: "Anrufen",
    emailUs: "E-Mail senden",
    retry: "Erneut versuchen",
    helpful: "Hilfreich",
    notHelpful: "Nicht hilfreich",
    feedbackThanks: "Danke für Ihr Feedback.",
    privacy: "Datenschutzhinweis",
    leadButton: "Nachricht senden",
    leadIntro: "Hinterlassen Sie Ihre Kontaktdaten, dann meldet sich unser Team bei Ihnen.",
    name: "Name",
    email: "E-Mail",
    phone: "Telefon",
    message: "Nachricht",
    optional: "optional",
    consent: "Ich bin einverstanden, zu meiner Anfrage kontaktiert zu werden.",
    includeConversation: "Dieses Gespräch mitsenden",
    cancel: "Abbrechen",
    leadSent: "Vielen Dank! Unser Team meldet sich bei Ihnen.",
    leadFailed: "Ihre Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es erneut.",
    fieldRequired: "Bitte füllen Sie dieses Feld aus.",
    emailInvalid: "Geben Sie eine E-Mail-Adresse wie name@beispiel.de ein.",
    phoneInvalid: "Geben Sie eine Telefonnummer ein.",
    consentRequired: "Setzen Sie dieses Häkchen, um Ihre Angaben zu senden.",
  },
  nl: {
    title: "Stel een vraag",
    open: "Openen",
    close: "Sluiten",
    closeChat: "Chat sluiten",
    ask: "Vragen",
    send: "Versturen",
    question: "Uw vraag",
    noAnswer: "Sorry, ik kon daar op deze site geen antwoord op vinden.",
    failed: "Er ging iets mis. Probeer het opnieuw.",
    almostReady: "Bijna klaar: deze chat wordt nog ingeschakeld voor deze site. Probeer het over een minuut opnieuw.",
    sources: "Bronnen",
    poweredBy: "Mogelijk gemaakt door Progress® Agentic RAG",
    welcome: "Hallo! Stel me gerust een vraag over deze site.",
    placeholder: "Stel een vraag…",
    disclosure: "Antwoorden worden door AI gegenereerd op basis van de inhoud van deze site en kunnen fouten bevatten.",
    offline: "De chat is op dit moment niet beschikbaar.",
    talkToPerson: "Met iemand praten",
    stillNeedHelp: "Nog hulp nodig?",
    prices: "De prijzen op onze prijspagina:",
    pricesOnPage: "Deze prijs vindt u op onze prijspagina.",
    checkingPrices: "We controleren onze prijzen…",
    perMonth: "per maand",
    perYear: "per jaar",
    handoff: "Ons team helpt u graag:",
    contactPage: "Contact",
    callUs: "Bel ons",
    emailUs: "Mail ons",
    retry: "Opnieuw proberen",
    helpful: "Nuttig",
    notHelpful: "Niet nuttig",
    feedbackThanks: "Bedankt voor uw feedback.",
    privacy: "Privacyverklaring",
    leadButton: "Stuur ons een bericht",
    leadIntro: "Laat uw gegevens achter, dan neemt ons team contact met u op.",
    name: "Naam",
    email: "E-mail",
    phone: "Telefoon",
    message: "Bericht",
    optional: "optioneel",
    consent: "Ik ga ermee akkoord dat er contact met mij wordt opgenomen over mijn vraag.",
    includeConversation: "Dit gesprek meesturen",
    cancel: "Annuleren",
    leadSent: "Bedankt! Ons team neemt contact met u op.",
    leadFailed: "Uw bericht kon niet worden verstuurd. Probeer het opnieuw.",
    fieldRequired: "Vul dit veld in.",
    emailInvalid: "Vul een e-mailadres in, zoals naam@voorbeeld.nl.",
    phoneInvalid: "Vul een telefoonnummer in.",
    consentRequired: "Vink dit vakje aan om uw gegevens te versturen.",
  },
  pt: {
    title: "Pergunte-nos",
    open: "Abrir",
    close: "Fechar",
    closeChat: "Fechar chat",
    ask: "Perguntar",
    send: "Enviar",
    question: "Sua pergunta",
    noAnswer: "Desculpe, não encontrei uma resposta para isso neste site.",
    failed: "Algo deu errado. Tente novamente.",
    almostReady: "Quase pronto: este chat ainda está sendo ativado neste site. Tente novamente em um minuto.",
    sources: "Fontes",
    poweredBy: "Com tecnologia Progress® Agentic RAG",
    welcome: "Olá! Pergunte-me qualquer coisa sobre este site.",
    placeholder: "Faça uma pergunta…",
    disclosure: "As respostas são geradas por IA a partir do conteúdo deste site e podem conter erros.",
    offline: "O chat não está disponível no momento.",
    talkToPerson: "Falar com uma pessoa",
    stillNeedHelp: "Ainda precisa de ajuda?",
    prices: "Os preços da nossa página de preços:",
    pricesOnPage: "Consulte este preço na nossa página de preços.",
    checkingPrices: "Verificando os nossos preços…",
    perMonth: "por mês",
    perYear: "por ano",
    handoff: "Nossa equipe pode ajudar:",
    contactPage: "Fale conosco",
    callUs: "Ligue para nós",
    emailUs: "Envie um e-mail",
    retry: "Tentar novamente",
    helpful: "Útil",
    notHelpful: "Não foi útil",
    feedbackThanks: "Obrigado pela sua avaliação.",
    privacy: "Aviso de privacidade",
    leadButton: "Envie uma mensagem",
    leadIntro: "Deixe seus dados e nossa equipe entrará em contato.",
    name: "Nome",
    email: "E-mail",
    phone: "Telefone",
    message: "Mensagem",
    optional: "opcional",
    consent: "Concordo em ser contatado sobre minha solicitação.",
    includeConversation: "Incluir esta conversa",
    cancel: "Cancelar",
    leadSent: "Obrigado! Nossa equipe entrará em contato.",
    leadFailed: "Não foi possível enviar sua mensagem. Tente novamente.",
    fieldRequired: "Preencha este campo.",
    emailInvalid: "Digite um e-mail como nome@exemplo.com.",
    phoneInvalid: "Digite um número de telefone.",
    consentRequired: "Marque esta caixa para enviar seus dados.",
  },
  it: {
    title: "Chiedi a noi",
    open: "Apri",
    close: "Chiudi",
    closeChat: "Chiudi chat",
    ask: "Chiedi",
    send: "Invia",
    question: "La tua domanda",
    noAnswer: "Mi dispiace, non ho trovato una risposta a questa domanda su questo sito.",
    failed: "Si è verificato un errore. Riprova.",
    almostReady: "Quasi pronto: questa chat è ancora in fase di attivazione su questo sito. Riprova tra un minuto.",
    sources: "Fonti",
    poweredBy: "Con tecnologia Progress® Agentic RAG",
    welcome: "Ciao! Chiedimi qualsiasi cosa su questo sito.",
    placeholder: "Fai una domanda…",
    disclosure: "Le risposte sono generate dall'IA a partire dai contenuti di questo sito e possono contenere errori.",
    offline: "La chat non è disponibile al momento.",
    talkToPerson: "Parla con una persona",
    stillNeedHelp: "Serve altro aiuto?",
    prices: "I prezzi della nostra pagina dei prezzi:",
    pricesOnPage: "Trova questo prezzo nella nostra pagina dei prezzi.",
    checkingPrices: "Sto controllando i nostri prezzi…",
    perMonth: "al mese",
    perYear: "all'anno",
    handoff: "Il nostro team può aiutarti:",
    contactPage: "Contattaci",
    callUs: "Chiamaci",
    emailUs: "Scrivici",
    retry: "Riprova",
    helpful: "Utile",
    notHelpful: "Non utile",
    feedbackThanks: "Grazie per il tuo feedback.",
    privacy: "Informativa sulla privacy",
    leadButton: "Inviaci un messaggio",
    leadIntro: "Lasciaci i tuoi dati e il nostro team ti ricontatterà.",
    name: "Nome",
    email: "Email",
    phone: "Telefono",
    message: "Messaggio",
    optional: "facoltativo",
    consent: "Accetto di essere ricontattato in merito alla mia richiesta.",
    includeConversation: "Includi questa conversazione",
    cancel: "Annulla",
    leadSent: "Grazie! Il nostro team ti ricontatterà.",
    leadFailed: "Non è stato possibile inviare il messaggio. Riprova.",
    fieldRequired: "Compila questo campo.",
    emailInvalid: "Inserisci un indirizzo email come nome@esempio.it.",
    phoneInvalid: "Inserisci un numero di telefono.",
    consentRequired: "Seleziona questa casella per inviare i tuoi dati.",
  },
};

export const widgetStrings = (language: Language): WidgetStrings => STRINGS[language];

const stringsOf = (languages: readonly Language[]): Partial<Record<Language, WidgetStrings>> =>
  Object.fromEntries(languages.map((code) => [code, STRINGS[code]]));

export const allWidgetStrings = () => stringsOf(LANGUAGES.map((l) => l.code));

// The text a deployment's public config carries: every language resolveLanguage can pick for it,
// less English, which the widget already has.
export function configStrings(setting: LanguageSetting, served: readonly Language[] = []): Partial<Record<Language, WidgetStrings>> {
  const languages = setting !== "auto" ? [setting] : served.length ? served : LANGUAGES.map((l) => l.code);
  return stringsOf(languages.filter((code) => code !== "en"));
}
