export class PlaybackControlCluster {
  constructor(root) {
    this.root = root;
    this.previousButton = root.locator('[data-playback-control-action="previous"]');
    this.playPauseButton = root.locator('[data-playback-control-action="play-pause"]');
    this.nextButton = root.locator('[data-playback-control-action="next"]');
    this.loopActions = root.locator('[data-playback-control-loop-actions]');
  }
}
