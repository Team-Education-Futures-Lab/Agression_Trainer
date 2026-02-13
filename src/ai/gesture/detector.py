"""
Hand gesture recognition using MediaPipe landmarks + TFLite classifier.

Based on: Kazuhito00/hand-gesture-recognition-using-mediapipe
License: Apache 2.0
URL: https://github.com/Kazuhito00/hand-gesture-recognition-using-mediapipe

Refactored for server-side processing without GUI dependencies.
Accepts hand landmarks from MediaPipe.js client and classifies gestures.
"""
import logging
import time

import numpy as np
from pathlib import Path
from typing import Union, Optional, List, Dict

try:
    from tensorflow import lite as tflite
except ImportError:
    import tflite_runtime.interpreter as tflite

logger = logging.getLogger(__name__)

class GestureDetector:
    """
    Detects hand gestures from MediaPipe hand landmarks.

    Expects 21 hand landmarks (x, y coordinates) from MediaPipe client.
    Returns gesture classification with confidence scores.

    Example:
        detector = GestureDetector()
        landmarks = [
            {'x': 0.5, 'y': 0.5},   # Wrist
            {'x': 0.52, 'y': 0.48}, # Thumb CMC
            # ... 19 more landmarks
        ]
        result = detector.detect(landmarks)
        print(result['gesture'])  # 'open_hand'
    """

    def __init__(
            self,
            model_path: Optional[Union[str, Path]] = None,
            labels_path: Optional[Union[str, Path]] = None
    ):
        """
        Initialize gesture detector with TFLite model.

        :param model_path: Path to .tflite model file.
        :param labels_path: Path to gesture labels CSV file.
        """
        from src.config.settings import settings

        self.model_path = Path(model_path) if model_path else settings.GESTURE_MODEL_PATH
        self.labels_path = Path(labels_path) if labels_path else settings.GESTURE_LABELS_PATH

        if not self.model_path.exists():
            raise FileNotFoundError(
                f"Gesture model not found: {self.model_path}\n"
                f"Expected location: {self.model_path.absolute()}\n"
                f"Run 'make models' or copy from old repository."
            )

        logger.info(f"Loading gesture model from {self.model_path}")

        self.labels = self._load_labels()
        logger.info(f"Loaded {len(self.labels)} gesture classes: {self.labels}")

        self.interpreter = tflite.Interpreter(model_path=str(self.model_path))
        self.interpreter.allocate_tensors()

        self.input_details = self.interpreter.get_input_details()
        self.output_details = self.interpreter.get_output_details()

        input_shape = self.input_details[0]['shape']
        output_shape = self.output_details[0]['shape']
        logger.info(f"Model input shape: {input_shape}")
        logger.info(f"Model output shape: {output_shape}")
        logger.info("✓ Gesture detector initialized successfully")

    def detect(self, hand_landmarks: List[Dict[str, float]]) -> Dict[str, any]:
        """
        Detect gestures from hand landmarks.

        :param hand_landmarks: List of 21 landmarks from MediaPipe
            Each landmark is a dict with a 'x' and 'y' keys
            Example: [{'x': 0.5, 'y': 0.5}, {'x': 0.52, 'y': 0.48}, ...]
        :return: Dictionary containing:
        {
                'gesture': str,              # Detected gesture name
                'confidence': float,         # Confidence score (0-1)
                'all_scores': dict,          # Probabilities for all gestures
                'hand_detected': bool,       # Whether valid hand was detected
                'processing_time_ms': float, # Processing time in milliseconds
                'landmark_count': int        # Number of landmarks received
        }
        """
        start_time = time.time()

        if not hand_landmarks:
            return self._no_detection_result(start_time, 0)

        if len(hand_landmarks) != 21:
            logger.warning(
                f"Expected 21 landmarks, received {len(hand_landmarks)} landmarks"
                f"Returning no detection"
            )
            return self._no_detection_result(start_time, 0)

        try:
            landmark_array = self._preprocess_landmarks(hand_landmarks)

            gesture_id, confidence, all_scores = self._classify(landmark_array)

            processing_time = (time.time() - start_time) * 1000

            return {
                'gesture': self.labels[gesture_id],
                'confidence': float(confidence),
                'all_scores': {
                    self.labels[i]: float(score)
                    for i, score in enumerate(all_scores)
                },
                'hand_detected': True,
                'processing_time_ms': processing_time,
                'landmark_count': 21
            }

        except Exception as e:
            logger.error(f"Error during gesture detection: {e}", exc_info=True)
            return self._no_detection_result(start_time, len(hand_landmarks))

    def _load_labels(self) -> List[str]:
        """
        Load gesture labels from CSV file.

        :return: List of gesture class names in order
        """
        if not self.labels_path.exists():
            logger.warning(
                f"Labels file not found: {self.labels_path}. "
                f"Using default labels.")
            return [
                'open_hand',
                'closed_fist',
                'pointing',
                'peace_sign',
                'thumbs_up'
            ]

        with open(self.labels_path, 'r', encoding='utf-8') as f:
            labels = [line.strip() for line in f.readlines() if line.strip()]

        if not labels:
            raise ValueError(f"No labels found in {self.labels_path}")

        return labels

    def _preprocess_landmarks(self, landmarks: List[Dict[str, float]]) -> np.ndarray:
        """
        Convert MediaPipe landmarks to normalized array for model input.

        Process:
        1. Extract x, y coordinates from each landmark
        2. Normalize relative to wrist (landmark 0)
        3. Flatten to 1D array [x0, y0, x1, y1, ..., x20, y20]

        :param landmarks: List of 21 landmarks with 'x' and 'y' keys
        :return: Normalized 1D numpy array of shape (42,) dtype float32
        """

        coords = np.array([
            [landmark['x'], landmark['y']]
            for landmark in landmarks
        ], dtype=np.float32)

        wrist = coords[0]
        normalized = coords - wrist

        flattened = normalized.flatten()
        return flattened

    def _classify(self, landmark_array: np.ndarray) -> tuple:
        """
        Run TFLite inference on preprocessed landmarks.

        :param landmark_array: Preprocessed landmarks (42 floats)
        :return: Tuple of (gesture_id, confidence, all_scores)
            - gesture_id: int - Index of detected gesture
            - confidence: float - Confidence of top prediction
            - all_scores: np.ndarray - All class probabilities
        """

        input_data = np.expand_dims(landmark_array, axis=0)
        input_data = input_data.astype(np.float32)

        self.interpreter.set_tensor(self.input_details[0]['index'], input_data)
        self.interpreter.invoke()
        output_data = self.interpreter.get_tensor(self.output_details[0]['index'])[0]

        gesture_id = int(np.argmax(output_data))
        confidence = float(output_data[gesture_id])

        return gesture_id, confidence, output_data

    def _no_detection_result(self, start_time: float, landmark_count: int) -> Dict[str, any]:
        """
        Return result when no valid hand is detected.

        :param start_time: Time when detection started
        :param landmark_count: Number of landmarks received
        :return: Dictionary with default values indicating no detection
        """
        processing_time = (time.time() - start_time) * 1000

        return {
            'gesture': 'none',
            'confidence': 0.0,
            'all_scores': {},
            'hand_detected': False,
            'processing_time_ms': processing_time,
            'landmark_count': landmark_count
        }

    def get_model_info(self) -> Dict[str, any]:
        """
        Get information about the loaded model.

        :return: Dictionary with model metadata
        """
        return {
            'model_path': str(self.model_path),
            'model_size_mb': self.model_path.stat().st_size / (1024 * 1024),
            'num_classes': len(self.labels),
            'class_labels': self.labels,
            'input_shape': self.input_details[0]['shape'].tolist(),
            'output_shape': self.output_details[0]['shape'].tolist(),
        }

    def cleanup(self):
        """
        Release model resources.

        TFLite models don't require explicit cleanup, but this method is provided for consistency with other detector classes.
        """
        logger.info("Gesture detector cleanup (no-op for TFLite)")