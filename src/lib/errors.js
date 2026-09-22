export class ConflictError extends Error {
  constructor(message = "The record was changed by someone else.") {
    super(message);
    this.name = "ConflictError";
  }
}

/** A problem with an uploaded workbook that the person can fix. The message is safe to show them. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

/** The row changed after the person's review started, so saving would overwrite something they never saw. */
export class StaleError extends Error {
  constructor(message = "This opportunity was changed after the transcript was analysed.") {
    super(message);
    this.name = "StaleError";
  }
}
