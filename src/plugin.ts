import streamDeck, { LogLevel } from "@elgato/streamdeck";

import {
  LikeAction,
  NextAction,
  PlayPauseAction,
  PreviousAction,
  RepeatAction,
  ShuffleAction,
} from "./actions/playback";
import { VolumeAction } from "./actions/volume";

streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new VolumeAction());
streamDeck.actions.registerAction(new PlayPauseAction());
streamDeck.actions.registerAction(new NextAction());
streamDeck.actions.registerAction(new PreviousAction());
streamDeck.actions.registerAction(new LikeAction());
streamDeck.actions.registerAction(new ShuffleAction());
streamDeck.actions.registerAction(new RepeatAction());

streamDeck.connect();
