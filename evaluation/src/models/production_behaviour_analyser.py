"""
Production implementation of BehaviourAnalyserInterface.

Placeholder only — the real multimodal classifier is implemented in a later
phase. Set BEHAVIOUR_ANALYSER=production only when the classifier is ready.
"""

from __future__ import annotations

from interfaces import AnalysisWindow, BehaviourAnalyserInterface, BehaviourResult


class ProductionBehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Production multimodal behaviour classifier.

    Not yet implemented. Raise NotImplementedError on any call until the
    real classifier is wired in.
    """

    async def analyse(self, window: AnalysisWindow) -> BehaviourResult:
        raise NotImplementedError(
            "ProductionBehaviourAnalyser is not yet implemented. "
            "Set BEHAVIOUR_ANALYSER=stub to use the stub implementation."
        )
