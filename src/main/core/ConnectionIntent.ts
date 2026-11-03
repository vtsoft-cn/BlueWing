/** Every asynchronous startup stage belongs to one cancellable request. */
export class ConnectionIntent {
  private revision = 0;
  private stops = 0;
  get isStopping(): boolean { return this.stops > 0; }
  begin(permitted: () => boolean = () => true): () => boolean {
    const revision = ++this.revision;
    return () => !this.isStopping && revision === this.revision && permitted();
  }
  cancel(): void { this.revision++; }
  beginStop(): () => void {
    this.cancel();
    this.stops++;
    return () => { this.stops--; };
  }
}
